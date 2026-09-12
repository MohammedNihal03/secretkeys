import { Client, type ClientConfig } from 'pg';

import { getEnv } from '@/lib/env';

/**
 * Opening a connection to a *monitored* database.
 *
 * Never the dashboard's pool. Every connection here is short-lived, opened for
 * one collection and closed again, because a monitoring tool that holds
 * connections open is competing for the very `max_connections` it is reporting
 * on.
 *
 * Four session settings are applied before anything is read, and each is there
 * to make a specific failure impossible:
 *
 * - `default_transaction_read_only` -- the collector cannot write to a customer
 *   database even if a query were changed to try.
 * - `statement_timeout` -- a monitoring query can never become the long-running
 *   query someone else's dashboard reports.
 * - `lock_timeout` -- it never waits behind a lock it did not take.
 * - `idle_in_transaction_session_timeout` -- a crash mid-collection cannot leave
 *   a transaction open, which would block vacuum indefinitely.
 *
 * They are applied with `SET` after connecting rather than as startup options,
 * because connection poolers in front of managed databases routinely reject
 * startup options and would turn a safety measure into an outage.
 */

export const CONNECTION_LIMITS = {
  connectTimeoutMs: 5_000,
  statementTimeoutMs: 5_000,
  lockTimeoutMs: 2_000,
  idleInTransactionTimeoutMs: 10_000,
} as const;

/** Identifies the collector in `pg_stat_activity` on the monitored server. */
export const APPLICATION_NAME = 'ai-db-observability-collector';

/** The connection details a target needs, with the secret separated out. */
export interface DatabaseConnectionInput {
  host: string;
  port: number;
  databaseName: string;
  username: string;
  sslEnabled: boolean;
  credentials: DatabaseCredentials;
}

/**
 * What the encrypted credential blob holds.
 *
 * A JSON payload rather than a bare password so TLS material can be added
 * without a migration, which is why the column was designed this way in Phase 1.
 */
export interface DatabaseCredentials {
  password: string;
  /** PEM certificate authority, for a server with a private CA. */
  ca?: string;
  /**
   * Whether the server certificate must validate. Defaults to true; an operator
   * has to opt out explicitly, per target, and the UI says what that costs.
   */
  rejectUnauthorized?: boolean;
}

export function buildClientConfig(input: DatabaseConnectionInput): ClientConfig {
  const { credentials } = input;

  return {
    host: input.host,
    port: input.port,
    database: input.databaseName,
    user: input.username,
    password: credentials.password,
    application_name: APPLICATION_NAME,
    connectionTimeoutMillis: CONNECTION_LIMITS.connectTimeoutMs,
    ssl: input.sslEnabled
      ? {
          // Verification on unless the operator turned it off for this target.
          rejectUnauthorized: credentials.rejectUnauthorized ?? true,
          ...(credentials.ca ? { ca: credentials.ca } : {}),
        }
      : false,
  };
}

/**
 * True when a target names the dashboard's own database.
 *
 * Not forbidden -- one PostgreSQL server often holds both, and an operator may
 * genuinely want to watch it. It is reported, because the figures then include
 * the dashboard's own load, and "connections are climbing" could be describing
 * the observer rather than the observed.
 */
export function isDashboardsOwnDatabase(input: {
  host: string;
  port: number;
  databaseName: string;
}): boolean {
  let own: URL;

  try {
    own = new URL(getEnv().DATABASE_URL);
  } catch {
    return false;
  }

  const ownPort = own.port ? Number(own.port) : 5432;
  const ownDatabase = decodeURIComponent(own.pathname.replace(/^\//, ''));

  return (
    own.hostname.toLowerCase() === input.host.toLowerCase() &&
    ownPort === input.port &&
    ownDatabase === input.databaseName
  );
}

/**
 * Removes anything that could identify a credential from an error message.
 *
 * Postgres driver errors quote connection parameters freely -- a failed TLS
 * negotiation or a DNS failure can echo the whole connection string. Nothing
 * from this module reaches a log or a UI without passing through here.
 */
export function scrubConnectionError(message: string, input?: { username?: string }): string {
  let cleaned = message.replace(/postgres(ql)?:\/\/[^\s'"]+/gi, '[connection string]');

  cleaned = cleaned.replace(/password=\S+/gi, 'password=[redacted]');

  if (input?.username) {
    // Escaped: a username is operator-supplied text, not a pattern.
    const escaped = input.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned.replace(new RegExp(`\\b${escaped}\\b`, 'g'), '[user]');
  }

  return cleaned;
}

/** A connected client plus how long each stage took. */
export interface OpenedConnection {
  client: Client;
  connectTimeMs: number;
}

/**
 * Connects and applies the session guards.
 *
 * Throws on failure: the caller decides what an unreachable database means,
 * and every caller here records it as a result rather than propagating it.
 */
export async function openMonitoringConnection(
  input: DatabaseConnectionInput
): Promise<OpenedConnection> {
  const client = new Client(buildClientConfig(input));
  const startedAt = performance.now();

  await client.connect();
  const connectTimeMs = Math.round(performance.now() - startedAt);

  try {
    await client.query(
      `set default_transaction_read_only = on;
       set statement_timeout = ${CONNECTION_LIMITS.statementTimeoutMs};
       set lock_timeout = ${CONNECTION_LIMITS.lockTimeoutMs};
       set idle_in_transaction_session_timeout = ${CONNECTION_LIMITS.idleInTransactionTimeoutMs}`
    );
  } catch (error) {
    // A connection that could not be made safe must not be used.
    await client.end().catch(() => {});
    throw error;
  }

  return { client, connectTimeMs };
}
