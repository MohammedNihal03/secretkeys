import { and, asc, eq, sql } from 'drizzle-orm';

import { getDb } from '@/lib/db/client';
import { monitoredDatabases, organizations, projects } from '@/lib/db/schema';
import type { HealthStatus } from '@/lib/health';
import type { Environment } from '@/lib/projects/schema';
import type { DatabaseTarget } from './types';

/**
 * Display-safe reads of registered databases.
 *
 * SECURITY: every query names its columns, and none of them is
 * `encrypted_credentials`. There is no `select()` of the whole row in this file,
 * so ciphertext cannot reach a page even as a field the UI ignores. Decryption
 * lives in `service.ts` and nowhere else -- the same division the API key layer
 * uses.
 *
 * Every function takes `organizationId` and filters on it.
 */

export type DatabaseStatus = 'active' | 'disabled';

export interface MonitoredDatabaseView {
  id: string;
  name: string;
  host: string;
  port: number;
  databaseName: string;
  username: string;
  sslEnabled: boolean;
  environment: Environment;
  status: DatabaseStatus;
  lastCheckedAt: Date | null;
  lastCheckStatus: HealthStatus | null;
  lastCheckDetail: string | null;
  createdAt: Date;
  updatedAt: Date;
  project: { id: string; name: string };
}

const SAFE_COLUMNS = {
  id: monitoredDatabases.id,
  name: monitoredDatabases.name,
  host: monitoredDatabases.host,
  port: monitoredDatabases.port,
  databaseName: monitoredDatabases.databaseName,
  username: monitoredDatabases.username,
  sslEnabled: monitoredDatabases.sslEnabled,
  environment: monitoredDatabases.environment,
  status: monitoredDatabases.status,
  lastCheckedAt: monitoredDatabases.lastCheckedAt,
  lastCheckStatus: monitoredDatabases.lastCheckStatus,
  lastCheckDetail: monitoredDatabases.lastCheckDetail,
  createdAt: monitoredDatabases.createdAt,
  updatedAt: monitoredDatabases.updatedAt,
  project: { id: projects.id, name: projects.name },
};

function baseQuery() {
  return getDb()
    .select(SAFE_COLUMNS)
    .from(monitoredDatabases)
    .innerJoin(projects, eq(monitoredDatabases.projectId, projects.id));
}

export async function listMonitoredDatabases(
  organizationId: string,
  options: { projectId?: string } = {}
): Promise<MonitoredDatabaseView[]> {
  const scope = options.projectId
    ? and(
        eq(monitoredDatabases.organizationId, organizationId),
        eq(monitoredDatabases.projectId, options.projectId)
      )
    : eq(monitoredDatabases.organizationId, organizationId);

  return baseQuery().where(scope).orderBy(asc(monitoredDatabases.name));
}

export async function getMonitoredDatabase(
  organizationId: string,
  databaseId: string
): Promise<MonitoredDatabaseView | null> {
  const [row] = await baseQuery()
    // Both predicates matter: the id alone would reach another tenant's row.
    .where(
      and(
        eq(monitoredDatabases.organizationId, organizationId),
        eq(monitoredDatabases.id, databaseId)
      )
    )
    .limit(1);

  return row ?? null;
}

/**
 * The databases a collection should visit.
 *
 * Only `active` rows: a target an operator disabled must stop being connected
 * to, not merely stop being displayed.
 */
export async function listDatabaseTargets(organizationId?: string): Promise<DatabaseTarget[]> {
  const conditions = [eq(monitoredDatabases.status, 'active')];

  if (organizationId) {
    conditions.push(eq(monitoredDatabases.organizationId, organizationId));
  }

  const rows = await getDb()
    .select({
      organizationId: monitoredDatabases.organizationId,
      organizationName: organizations.name,
      projectId: monitoredDatabases.projectId,
      projectName: projects.name,
      databaseId: monitoredDatabases.id,
      name: monitoredDatabases.name,
      host: monitoredDatabases.host,
      port: monitoredDatabases.port,
      databaseName: monitoredDatabases.databaseName,
      username: monitoredDatabases.username,
      sslEnabled: monitoredDatabases.sslEnabled,
      environment: monitoredDatabases.environment,
    })
    .from(monitoredDatabases)
    .innerJoin(projects, eq(monitoredDatabases.projectId, projects.id))
    .innerJoin(organizations, eq(monitoredDatabases.organizationId, organizations.id))
    .where(and(...conditions))
    .orderBy(asc(organizations.name), asc(monitoredDatabases.name));

  return rows;
}

/**
 * Records what the last connection attempt found.
 *
 * A snapshot, deliberately overwritten each time: the history of collections
 * belongs to the metric time series, and keeping a second copy here would give
 * two answers to "is this database up".
 */
export async function recordCheck(
  organizationId: string,
  databaseId: string,
  status: HealthStatus,
  detail: string | null
): Promise<void> {
  await getDb()
    .update(monitoredDatabases)
    .set({
      // The database clock, consistent with every other timestamp.
      lastCheckedAt: sql`now()`,
      lastCheckStatus: status,
      lastCheckDetail: detail,
    })
    .where(
      and(
        eq(monitoredDatabases.organizationId, organizationId),
        eq(monitoredDatabases.id, databaseId)
      )
    );
}

export async function setDatabaseStatus(
  organizationId: string,
  databaseId: string,
  status: DatabaseStatus
): Promise<boolean> {
  const updated = await getDb()
    .update(monitoredDatabases)
    .set({ status })
    .where(
      and(
        eq(monitoredDatabases.organizationId, organizationId),
        eq(monitoredDatabases.id, databaseId)
      )
    )
    .returning({ id: monitoredDatabases.id });

  return updated.length > 0;
}
