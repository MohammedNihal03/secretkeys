import { and, eq } from 'drizzle-orm';

import {
  CredentialDecryptionError,
  decryptSecret,
  encryptionConfigurationError,
  encryptSecret,
} from '@/lib/credentials/crypto';
import { getDb } from '@/lib/db/client';
import { getConstraintName, getSqlState, PG_ERROR } from '@/lib/db/errors';
import { monitoredDatabases, projects } from '@/lib/db/schema';
import type { HealthStatus } from '@/lib/health';
import {
  describeConnectionFailure,
  openMonitoringConnection,
  type DatabaseCredentials,
} from './connection';
import { SERVER_INFO_SQL, type ServerInfoRow } from './queries';
import { recordCheck } from './repository';
import type { RegisterDatabaseFieldErrors, RegisterDatabaseValues } from './schema';
import type { DatabaseTarget } from './types';

/**
 * Registering, checking and using monitored-database credentials.
 *
 * The same five steps the API key layer follows, for the same reasons:
 *
 *   1. validate the project        (exists, and belongs to this organization)
 *   2. check the credential        (connect to the server and read one row)
 *   3. encrypt it                  (AES-256-GCM, bound to the organization)
 *   4. store the metadata          (host, port, role -- never the password)
 *   5. never return the secret     (nothing here returns or logs it)
 *
 * SECURITY: the password only exists in function arguments and inside the
 * encrypted payload. Every message that reaches a caller passes through
 * `scrubConnectionError`, because PostgreSQL driver errors quote connection
 * parameters freely.
 */

const DATABASE_PURPOSE = 'database_credentials' as const;

/** SQLSTATEs that mean the credential itself is wrong, not the network. */
const REJECTED_SQLSTATES = new Set([
  /** invalid_password */
  '28P01',
  /** invalid_authorization_specification, including "no pg_hba.conf entry" */
  '28000',
  /** invalid_catalog_name: the database does not exist */
  '3D000',
]);

export type CheckOutcome = 'connected' | 'rejected' | 'unreachable';

export interface ConnectionCheck {
  outcome: CheckOutcome;
  status: HealthStatus;
  detail: string | null;
  serverVersion?: string;
}

/**
 * Connects once and reads the server's identity.
 *
 * Used both when registering and when an operator asks to re-check, so what
 * "this database is reachable" means never differs between the two.
 */
export async function checkConnection(
  input: {
    host: string;
    port: number;
    databaseName: string;
    username: string;
    sslEnabled: boolean;
  },
  credentials: DatabaseCredentials,
  open = openMonitoringConnection
): Promise<ConnectionCheck> {
  let opened: Awaited<ReturnType<typeof openMonitoringConnection>> | undefined;

  try {
    opened = await open({ ...input, credentials });
    const result = await opened.client.query<ServerInfoRow>(SERVER_INFO_SQL);
    const row = result.rows[0];

    return {
      outcome: 'connected',
      status: 'healthy',
      detail: null,
      ...(row ? { serverVersion: row.server_version } : {}),
    };
  } catch (error) {
    const detail = describeConnectionFailure(error, { username: input.username });
    const sqlState = getSqlState(error);

    if (sqlState && REJECTED_SQLSTATES.has(sqlState)) {
      /**
       * The server answered and refused us. Saving this would store a
       * credential already known not to work, so registration stops here --
       * the same rule the API key layer applies to a 401.
       */
      return { outcome: 'rejected', status: 'unhealthy', detail };
    }

    /**
     * Anything else -- a timeout, a refused TCP connection, TLS trouble -- is
     * not evidence against the credential. A database being down at
     * registration time is a normal thing to want to record and watch.
     */
    return { outcome: 'unreachable', status: 'unknown', detail };
  } finally {
    await opened?.client.end().catch(() => {});
  }
}

export type RegisterDatabaseResult =
  | { ok: true; databaseId: string; outcome: CheckOutcome; detail: string | null }
  | { ok: false; errors: RegisterDatabaseFieldErrors }
  | { ok: false; error: string };

export async function registerMonitoredDatabase(
  organizationId: string,
  input: RegisterDatabaseValues,
  deps: { check?: typeof checkConnection } = {}
): Promise<RegisterDatabaseResult> {
  const configurationError = encryptionConfigurationError();
  if (configurationError) return { ok: false, error: configurationError };

  const db = getDb();

  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    // Both predicates: a project id alone would let one tenant name another's.
    .where(and(eq(projects.organizationId, organizationId), eq(projects.id, input.projectId)))
    .limit(1);

  if (!project) {
    return { ok: false, errors: { projectId: 'That project does not exist.' } };
  }

  const credentials: DatabaseCredentials = {
    password: input.password,
    ...(input.ca ? { ca: input.ca } : {}),
    ...(input.allowUnverifiedCertificate ? { rejectUnauthorized: false } : {}),
  };

  const check = await (deps.check ?? checkConnection)(
    {
      host: input.host,
      port: input.port,
      databaseName: input.databaseName,
      username: input.username,
      sslEnabled: input.sslEnabled,
    },
    credentials
  );

  if (check.outcome === 'rejected') {
    return {
      ok: false,
      errors: {
        form: `PostgreSQL refused the connection: ${check.detail ?? 'the credential was rejected.'}`,
      },
    };
  }

  try {
    const [row] = await db
      .insert(monitoredDatabases)
      .values({
        organizationId,
        projectId: input.projectId,
        name: input.name,
        host: input.host,
        port: input.port,
        databaseName: input.databaseName,
        username: input.username,
        encryptedCredentials: encryptSecret(JSON.stringify(credentials), {
          organizationId,
          purpose: DATABASE_PURPOSE,
        }),
        sslEnabled: input.sslEnabled,
        environment: input.environment,
        lastCheckStatus: check.status,
        lastCheckDetail: check.detail,
      })
      .returning({ id: monitoredDatabases.id });

    if (check.outcome === 'connected') {
      await recordCheck(organizationId, row.id, check.status, check.detail);
    }

    return { ok: true, databaseId: row.id, outcome: check.outcome, detail: check.detail };
  } catch (error) {
    if (getSqlState(error) === PG_ERROR.uniqueViolation) {
      const constraint = getConstraintName(error);

      if (constraint === 'monitored_databases_org_target_unique') {
        return {
          ok: false,
          errors: {
            host: 'That host, port and database are already registered in this organization.',
          },
        };
      }

      return { ok: false, errors: { name: 'A database with that name already exists.' } };
    }

    // Never rethrow the driver error: its message carries the parameters.
    return {
      ok: false,
      error: `The database could not be saved (SQLSTATE ${getSqlState(error) ?? 'unknown'}).`,
    };
  }
}

export type LoadedCredentials = { credentials: DatabaseCredentials } | { error: string } | null;

/**
 * Decrypts one target's credentials.
 *
 * The only place ciphertext is read. Returns a message rather than throwing for
 * a decryption failure, because the usual cause is a retired encryption key,
 * and that is an operator problem to report next to the target it affects.
 */
export async function loadDatabaseCredentials(
  organizationId: string,
  databaseId: string
): Promise<LoadedCredentials> {
  const [row] = await getDb()
    .select({ encryptedCredentials: monitoredDatabases.encryptedCredentials })
    .from(monitoredDatabases)
    .where(
      and(
        eq(monitoredDatabases.organizationId, organizationId),
        eq(monitoredDatabases.id, databaseId)
      )
    )
    .limit(1);

  if (!row) return null;

  try {
    const plaintext = decryptSecret(row.encryptedCredentials, {
      organizationId,
      purpose: DATABASE_PURPOSE,
    });

    const parsed: unknown = JSON.parse(plaintext);

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { password?: unknown }).password !== 'string'
    ) {
      return { error: 'The stored credentials are not in the expected format.' };
    }

    return { credentials: parsed as DatabaseCredentials };
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      return { error: error.message };
    }

    // Never include the payload; a JSON parse error would quote the plaintext.
    return { error: 'The stored credentials could not be read.' };
  }
}

/** Re-checks a registered database and records the result. */
export async function recheckDatabase(
  organizationId: string,
  databaseId: string,
  target: Pick<DatabaseTarget, 'host' | 'port' | 'databaseName' | 'username' | 'sslEnabled'>
): Promise<{ ok: true; check: ConnectionCheck } | { ok: false; error: string }> {
  const loaded = await loadDatabaseCredentials(organizationId, databaseId);

  if (loaded === null) return { ok: false, error: 'That database is no longer registered.' };
  if ('error' in loaded) return { ok: false, error: loaded.error };

  const check = await checkConnection(target, loaded.credentials);
  await recordCheck(organizationId, databaseId, check.status, check.detail);

  return { ok: true, check };
}
