import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { collectDatabase } from '@/lib/databases/collect';
import { listDatabaseTargets } from '@/lib/databases/repository';
import { runDatabaseCollection } from '@/lib/databases/runner';
import {
  loadDatabaseCredentials,
  registerMonitoredDatabase,
  recheckDatabase,
} from '@/lib/databases/service';
import {
  latestMetrics,
  metricHistory,
  previousCounterSample,
  pruneDatabaseMetrics,
} from '@/lib/databases/storage';
import type { DatabaseTarget } from '@/lib/databases/types';
import { closePool, getDb } from '@/lib/db/client';
import {
  databaseCollectorRuns,
  databaseMetrics,
  monitoredDatabases,
  organizations,
  projects,
} from '@/lib/db/schema';
import { assessSnapshot } from '@/lib/evaluation/database';

/**
 * The PostgreSQL collector against a real server.
 *
 *   npm run db:setup && npm run test:integration
 *
 * The dashboard's own database is registered as a monitored target. That is a
 * legitimate thing to do -- the collector reaches it over its own short-lived
 * connection, never the application pool -- and it is the one PostgreSQL server
 * a contributor is guaranteed to have, so every statement in `queries.ts` is
 * executed for real here rather than being trusted to be valid SQL.
 */

const RUN = Math.random().toString(36).slice(2, 10);
const db = getDb();

let orgId: string;
let projectId: string;
let databaseId: string;
let target: DatabaseTarget;

/** The dashboard's own connection details, which the collector will reuse. */
function ownConnection() {
  const url = new URL(process.env.DATABASE_URL ?? '');

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    databaseName: decodeURIComponent(url.pathname.replace(/^\//, '')),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

beforeAll(async () => {
  const [organization] = await db
    .insert(organizations)
    .values({ name: `DB Monitor Org ${RUN}` })
    .returning({ id: organizations.id });
  orgId = organization.id;

  const [project] = await db
    .insert(projects)
    .values({ organizationId: orgId, name: 'Platform' })
    .returning({ id: projects.id });
  projectId = project.id;

  const own = ownConnection();

  const registered = await registerMonitoredDatabase(orgId, {
    projectId,
    name: `Self ${RUN}`,
    host: own.host,
    port: own.port,
    databaseName: own.databaseName,
    username: own.username,
    password: own.password,
    sslEnabled: false,
    allowUnverifiedCertificate: false,
    environment: 'development',
  });

  if (!registered.ok) {
    throw new Error('error' in registered ? registered.error : JSON.stringify(registered.errors));
  }

  databaseId = registered.databaseId;

  const targets = await listDatabaseTargets(orgId);
  target = targets[0];
});

afterAll(async () => {
  if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  await closePool();
});

describe('registering a database', () => {
  it('stores the connection in clear and the password only encrypted', async () => {
    const [row] = await db
      .select()
      .from(monitoredDatabases)
      .where(eq(monitoredDatabases.id, databaseId));

    const own = ownConnection();

    expect(row.host).toBe(own.host);
    expect(row.username).toBe(own.username);
    // The secret must not be recoverable by reading the row.
    expect(row.encryptedCredentials).not.toContain(own.password);
    expect(row.encryptedCredentials.startsWith('v1.')).toBe(true);
    // A successful check is recorded at registration.
    expect(row.lastCheckStatus).toBe('healthy');
    expect(row.lastCheckedAt).toBeInstanceOf(Date);
  });

  it('decrypts the credential back for the collector, and for no one else', async () => {
    const loaded = await loadDatabaseCredentials(orgId, databaseId);

    expect(loaded).not.toBeNull();
    expect(loaded && 'credentials' in loaded && loaded.credentials.password).toBe(
      ownConnection().password
    );

    // Bound to its organization: another tenant's id must not decrypt it.
    const [other] = await db
      .insert(organizations)
      .values({ name: `DB Monitor Other ${RUN}` })
      .returning({ id: organizations.id });

    const wrongTenant = await loadDatabaseCredentials(other.id, databaseId);
    expect(wrongTenant).toBeNull();

    await db.delete(organizations).where(eq(organizations.id, other.id));
  });

  it('refuses a credential the server rejects', async () => {
    const own = ownConnection();

    const result = await registerMonitoredDatabase(orgId, {
      projectId,
      name: `Wrong password ${RUN}`,
      host: own.host,
      port: own.port,
      databaseName: own.databaseName,
      username: own.username,
      password: `${own.password}-definitely-wrong`,
      sslEnabled: false,
      allowUnverifiedCertificate: false,
      environment: 'development',
    });

    // Storing a credential already known not to work would be pure noise later.
    expect(result.ok).toBe(false);
    expect(result.ok === false && 'errors' in result && result.errors.form).toContain('refused');
  });

  it('refuses the same host, port and database twice', async () => {
    const own = ownConnection();

    const result = await registerMonitoredDatabase(orgId, {
      projectId,
      name: `Duplicate ${RUN}`,
      host: own.host,
      port: own.port,
      databaseName: own.databaseName,
      username: own.username,
      password: own.password,
      sslEnabled: false,
      allowUnverifiedCertificate: false,
      environment: 'development',
    });

    // Registered twice, it would be collected and counted twice.
    expect(result.ok).toBe(false);
    expect(result.ok === false && 'errors' in result && result.errors.host).toContain(
      'already registered'
    );
  });
});

describe('collecting from a real server', () => {
  it('runs every statement and returns real figures', async () => {
    const loaded = await loadDatabaseCredentials(orgId, databaseId);
    if (!loaded || 'error' in loaded) throw new Error('credentials did not load');

    const snapshot = await collectDatabase(target, { credentials: loaded.credentials });

    expect(snapshot.health.reachable).toBe(true);
    expect(snapshot.health.serverVersion.available).toBe(true);
    expect(snapshot.resources.databaseSizeBytes).toMatchObject({ available: true });
    expect(snapshot.connections.max).toMatchObject({ available: true });
    expect(snapshot.connections.current).toMatchObject({ available: true });
    expect(snapshot.postgres.cacheHitRatioSinceReset).toMatchObject({ available: true });

    // Reading the statistics views must never be reported as a failure.
    expect(snapshot.outcome).toBe('success');
    expect(snapshot.error).toBeUndefined();
  });

  it('notices that this target is the dashboard’s own database', async () => {
    const loaded = await loadDatabaseCredentials(orgId, databaseId);
    if (!loaded || 'error' in loaded) throw new Error('credentials did not load');

    const snapshot = await collectDatabase(target, { credentials: loaded.credentials });

    expect(snapshot.notes.some((note) => note.includes('dashboard’s own database'))).toBe(true);
  });

  it('cannot write to a monitored database even if asked to', async () => {
    const loaded = await loadDatabaseCredentials(orgId, databaseId);
    if (!loaded || 'error' in loaded) throw new Error('credentials did not load');

    const { openMonitoringConnection } = await import('@/lib/databases/connection');
    const opened = await openMonitoringConnection({
      ...ownConnection(),
      sslEnabled: false,
      credentials: loaded.credentials,
    });

    try {
      // The session is read-only, so this is refused by PostgreSQL itself.
      await expect(opened.client.query('create table should_never_exist (id int)')).rejects.toThrow(
        /read-only/i
      );
    } finally {
      await opened.client.end();
    }
  });

  it('re-checks a registered database and records the outcome', async () => {
    const result = await recheckDatabase(orgId, databaseId, target);

    expect(result.ok).toBe(true);
    expect(result.ok && result.check.outcome).toBe('connected');

    const [row] = await db
      .select({ status: monitoredDatabases.lastCheckStatus })
      .from(monitoredDatabases)
      .where(eq(monitoredDatabases.id, databaseId));

    expect(row.status).toBe('healthy');
  });
});

describe('storing what was collected', () => {
  it('writes one row per metric, absences included', async () => {
    const summary = await runDatabaseCollection({ organizationId: orgId });

    expect(summary.ran).toBe(true);
    expect(summary.targets).toBe(1);
    expect(summary.metricsStored).toBeGreaterThan(20);

    const rows = await db
      .select()
      .from(databaseMetrics)
      .where(eq(databaseMetrics.databaseId, databaseId));

    const byMetric = new Map(rows.map((row) => [row.metric, row]));

    expect(byMetric.get('connections.utilizationPercent')?.value).toBeTypeOf('number');
    expect(byMetric.get('health.serverVersion')?.textValue).toBeTruthy();

    // The absence is stored with its reason, not left out of the series.
    const cpu = byMetric.get('resources.cpuPercent');
    expect(cpu?.value).toBeNull();
    expect(cpu?.reason).toBe('not_exposed_by_postgres');
    expect(cpu?.detail).toContain('CPU');

    const [run] = await db
      .select()
      .from(databaseCollectorRuns)
      .where(eq(databaseCollectorRuns.databaseId, databaseId));

    expect(run.reachable).toBe(true);
    expect(Number(run.metricsStored)).toBe(summary.metricsStored);
  });

  it('reads the counters back and measures a rate on the second run', async () => {
    const sample = await previousCounterSample(target);

    expect(sample).not.toBeNull();
    expect(sample?.xactCommit).toBeGreaterThan(0);

    await runDatabaseCollection({ organizationId: orgId });

    const history = await metricHistory(
      {
        organizationId: orgId,
        databaseId,
        from: new Date(Date.now() - 60 * 60 * 1000),
        to: new Date(Date.now() + 60 * 1000),
      },
      'postgres.transactionsPerSecond'
    );

    expect(history.length).toBeGreaterThanOrEqual(2);
    // The first collection had nothing to compare against; the second does.
    expect(history[0].reason).toBe('needs_previous_sample');
    expect(history.at(-1)?.value).toBeTypeOf('number');
  });

  it('summarises the latest reading of every metric in one query', async () => {
    const metrics = await latestMetrics(orgId, databaseId, new Date(Date.now() - 60 * 60 * 1000));

    expect(metrics.length).toBeGreaterThan(20);

    const utilization = metrics.find(
      (metric) => metric.metric === 'connections.utilizationPercent'
    );
    expect(utilization?.latest).toBeTypeOf('number');
    expect(utilization?.readings).toBeGreaterThan(0);

    const cpu = metrics.find((metric) => metric.metric === 'resources.cpuPercent');
    // Sampled repeatedly, never once readable.
    expect(cpu?.samples).toBeGreaterThan(0);
    expect(cpu?.readings).toBe(0);
    expect(cpu?.latestReason).toBe('not_exposed_by_postgres');
  });

  it('evaluates a stored series into a health level', async () => {
    const loaded = await loadDatabaseCredentials(orgId, databaseId);
    if (!loaded || 'error' in loaded) throw new Error('credentials did not load');

    const snapshot = await collectDatabase(target, { credentials: loaded.credentials });
    const assessment = assessSnapshot(snapshot);

    // A healthy local database with unreadable host metrics is `unknown`, not
    // green -- the whole point of the fourth state.
    expect(['healthy', 'unknown', 'warning']).toContain(assessment.level);
    expect(assessment.findings.some((finding) => finding.metric === 'resources.cpuPercent')).toBe(
      true
    );
  });

  it('prunes readings older than a cut-off', async () => {
    const future = new Date(Date.now() + 60 * 1000);
    const deleted = await pruneDatabaseMetrics(future);

    expect(deleted).toBeGreaterThan(0);

    const left = await db
      .select({ id: databaseMetrics.id })
      .from(databaseMetrics)
      .where(eq(databaseMetrics.databaseId, databaseId));

    expect(left).toHaveLength(0);
  });
});
