import { describe, expect, it, vi } from 'vitest';

import {
  canSeeAllBackends,
  classifyOutcome,
  collectDatabase,
  delta,
  eachMetric,
  type MonitoringClient,
} from '@/lib/databases/collect';
import { buildClientConfig, scrubConnectionError } from '@/lib/databases/connection';
import { snapshotToRows } from '@/lib/databases/storage';
import type { CounterSample, DatabaseTarget } from '@/lib/databases/types';

/**
 * The PostgreSQL collector, without a PostgreSQL server.
 *
 * Every query is answered by a stub, so what is tested here is the part that
 * decides meaning: whether a metric is a number or a reason, what a counter
 * delta is allowed to claim, and what the collector refuses to do to a customer
 * database. The integration suite runs the real SQL.
 */

function target(overrides: Partial<DatabaseTarget> = {}): DatabaseTarget {
  return {
    organizationId: 'org-1',
    organizationName: 'Acme',
    projectId: 'project-1',
    projectName: 'FYIND',
    databaseId: 'db-1',
    name: 'Production Primary',
    host: 'db.internal',
    port: 5432,
    databaseName: 'app',
    username: 'observability',
    sslEnabled: true,
    environment: 'production',
    ...overrides,
  };
}

const SERVER = {
  server_version: '16.4',
  max_connections: 100,
  reserved_connections: 3,
  database_name: 'app',
  in_recovery: false,
  uptime_seconds: 86_400,
  is_superuser: false,
  has_pg_monitor: true,
  has_read_all_stats: false,
  has_statement_stats: false,
};

const CONNECTIONS = {
  total: 42,
  active: 5,
  idle: 30,
  idle_in_transaction: 7,
  on_this_database: 40,
  hidden: 0,
};

const SIZE = { database_size_bytes: 1_073_741_824, cluster_size_bytes: 2_147_483_648 };

const STATS = {
  xact_commit: 1_000,
  xact_rollback: 25,
  blks_read: 500,
  blks_hit: 9_500,
  deadlocks: 2,
  conflicts: 0,
  temp_files: 1,
  temp_bytes: 4_096,
  numbackends: 40,
  stats_reset: new Date('2026-09-01T00:00:00Z'),
};

const LOCKS = { waiting: 0, total: 12 };

const ACTIVITY = {
  active: 3,
  slow: 1,
  long_running: 0,
  longest_running_seconds: 12.5,
  blocked: 0,
};

interface StubOptions {
  server?: Partial<typeof SERVER>;
  connections?: Partial<typeof CONNECTIONS> | null;
  stats?: Partial<typeof STATS> | null;
  size?: Partial<typeof SIZE> | null;
  clusterSize?: Partial<typeof SIZE> | null;
  locks?: Partial<typeof LOCKS> | null;
  activity?: Partial<typeof ACTIVITY> | null;
  /** Substrings of statements that should fail, with the message to raise. */
  failing?: Record<string, string>;
}

/** A client that answers each statement by recognising it. */
function stubClient(options: StubOptions = {}) {
  const statements: string[] = [];
  const end = vi.fn(async () => {});

  const client: MonitoringClient = {
    async query<T>(text: string): Promise<{ rows: T[] }> {
      statements.push(text);

      for (const [needle, message] of Object.entries(options.failing ?? {})) {
        if (text.includes(needle)) throw new Error(message);
      }

      const answer = (
        table: Record<string, unknown> | null | undefined,
        overrides: Record<string, unknown> | null | undefined
      ) =>
        overrides === null ? { rows: [] as T[] } : { rows: [{ ...table, ...overrides }] as T[] };

      if (text.includes('has_pg_monitor')) return answer(SERVER, options.server);
      if (text.includes('pg_database_size(current_database())'))
        return answer({ database_size_bytes: SIZE.database_size_bytes }, options.size);
      if (text.includes('pg_database_size'))
        return answer({ cluster_size_bytes: SIZE.cluster_size_bytes }, options.clusterSize);
      if (text.includes('backend_type')) {
        return text.includes('pg_backend_pid')
          ? answer(ACTIVITY, options.activity)
          : answer(CONNECTIONS, options.connections);
      }
      if (text.includes('pg_locks')) return answer(LOCKS, options.locks);
      if (text.includes('pg_stat_database')) return answer(STATS, options.stats);

      return { rows: [] };
    },
    end,
  };

  return { client, statements, end };
}

function collectWith(options: StubOptions = {}, previous?: CounterSample | null) {
  const stub = stubClient(options);

  return {
    stub,
    snapshot: collectDatabase(target(), {
      credentials: { password: 'not-a-real-password' },
      previous: previous ?? null,
      isOwnDatabase: () => false,
      open: async () => ({ client: stub.client, connectTimeMs: 4 }),
    }),
  };
}

describe('collecting from a database', () => {
  it('reports availability, sizes and connections', async () => {
    const { snapshot } = collectWith();
    const result = await snapshot;

    expect(result.health.reachable).toBe(true);
    expect(result.status).toBe('healthy');
    expect(result.outcome).toBe('success');
    expect(result.health.serverVersion).toEqual({ available: true, value: '16.4' });
    expect(result.resources.databaseSizeBytes).toEqual({ available: true, value: 1_073_741_824 });
    expect(result.connections.current).toEqual({ available: true, value: 42 });
    expect(result.connections.utilizationPercent).toEqual({ available: true, value: 42 });
  });

  it('closes the connection even when a query fails', async () => {
    const { stub, snapshot } = collectWith({ failing: { pg_locks: 'permission denied' } });
    await snapshot;

    // A leaked connection on a monitored server is the worst thing this can do.
    expect(stub.end).toHaveBeenCalledTimes(1);
  });

  it('loses only the metrics of the query that failed', async () => {
    const { snapshot } = collectWith({ failing: { pg_locks: 'permission denied for table' } });
    const result = await snapshot;

    expect(result.queries.waitingLocks).toMatchObject({ available: false, reason: 'query_error' });
    // Everything else still arrived.
    expect(result.connections.current.available).toBe(true);
    expect(result.postgres.blocksHit.available).toBe(true);
    expect(result.outcome).toBe('partial');
  });

  it('never counts its own backend as an active query', async () => {
    const { stub, snapshot } = collectWith();
    await snapshot;

    const activity = stub.statements.find((text) => text.includes('longest_running_seconds'));
    expect(activity).toContain('pid <> pg_backend_pid()');
  });

  it('says a metric is hidden rather than reporting it as zero', async () => {
    const { snapshot } = collectWith({
      server: { has_pg_monitor: false, has_read_all_stats: false, is_superuser: false },
      connections: { hidden: 9 },
    });
    const result = await snapshot;

    expect(result.connections.active).toMatchObject({
      available: false,
      reason: 'insufficient_privilege',
    });
    expect(result.queries.active).toMatchObject({ reason: 'insufficient_privilege' });
    // The count of connections is still visible without the grant.
    expect(result.connections.current).toEqual({ available: true, value: 42 });
    expect(result.notes.some((note) => note.includes('GRANT pg_monitor'))).toBe(true);
    expect(result.outcome).toBe('partial');
  });

  it('trusts the detail when nothing is actually hidden', () => {
    // A role that owns every connection sees them all without pg_monitor.
    expect(
      canSeeAllBackends({
        isSuperuser: false,
        hasPgMonitor: false,
        hasReadAllStats: false,
        hiddenBackends: 0,
      })
    ).toBe(true);
  });

  it('warns when a superuser is used for monitoring', async () => {
    const { snapshot } = collectWith({ server: { is_superuser: true } });
    const result = await snapshot;

    expect(result.notes.some((note) => note.includes('pg_monitor is enough'))).toBe(true);
  });

  it('does not run the multi-second cluster-size sum on a schedule', async () => {
    const { stub, snapshot } = collectWith();
    const result = await snapshot;

    expect(result.resources.clusterSizeBytes).toMatchObject({
      available: false,
      reason: 'too_expensive',
    });
    // Not merely unreported: the query is never sent.
    expect(stub.statements.some((text) => text.includes('from pg_database d'))).toBe(false);
    // This database's own size, which is what growth is measured from, is read.
    expect(result.resources.databaseSizeBytes.available).toBe(true);
    // A deliberate omission is not a partial collection.
    expect(result.outcome).toBe('success');
  });

  it('sums the cluster when explicitly asked to', async () => {
    const stub = stubClient();
    const result = await collectDatabase(target(), {
      credentials: { password: 'not-a-real-password' },
      isOwnDatabase: () => false,
      includeClusterSize: true,
      open: async () => ({ client: stub.client, connectTimeMs: 1 }),
    });

    expect(result.resources.clusterSizeBytes).toEqual({ available: true, value: 2_147_483_648 });
  });

  it('says plainly that CPU, memory and disk are not PostgreSQL’s to report', async () => {
    const { snapshot } = collectWith();
    const result = await snapshot;

    for (const metric of [
      result.resources.cpuPercent,
      result.resources.memoryPercent,
      result.resources.diskFreeBytes,
    ]) {
      expect(metric).toMatchObject({ available: false, reason: 'not_exposed_by_postgres' });
    }

    // A permanent absence is not a failed collection.
    expect(result.outcome).toBe('success');
  });

  it('records an unreachable database as a result, not an exception', async () => {
    const result = await collectDatabase(target(), {
      credentials: { password: 'not-a-real-password' },
      isOwnDatabase: () => false,
      open: async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
      },
    });

    expect(result.health.reachable).toBe(false);
    expect(result.status).toBe('unhealthy');
    expect(result.outcome).toBe('failed');
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('notes when the target is the dashboard’s own database', async () => {
    const stub = stubClient();
    const result = await collectDatabase(target(), {
      credentials: { password: 'not-a-real-password' },
      isOwnDatabase: () => true,
      open: async () => ({ client: stub.client, connectTimeMs: 1 }),
    });

    expect(result.notes[0]).toContain('dashboard’s own database');
  });
});

describe('rates and deltas', () => {
  const previous: CounterSample = {
    collectedAt: new Date('2026-09-12T10:00:00Z'),
    xactCommit: 900,
    xactRollback: 20,
    blocksHit: 9_000,
    blocksRead: 450,
    deadlocks: 1,
    databaseSizeBytes: 1_000_000_000,
    statsResetAt: new Date('2026-09-01T00:00:00Z'),
  };

  it('needs two samples before it will report a rate', async () => {
    const { snapshot } = collectWith();
    const result = await snapshot;

    expect(result.postgres.transactionsPerSecond).toMatchObject({
      available: false,
      reason: 'needs_previous_sample',
    });
    // And waiting for a second sample is not a partial collection.
    expect(result.outcome).toBe('success');
  });

  it('computes the transaction rate and interval cache ratio from two samples', async () => {
    const stub = stubClient();
    const startedAt = new Date('2026-09-12T10:01:00Z');

    const result = await collectDatabase(target(), {
      credentials: { password: 'not-a-real-password' },
      previous,
      isOwnDatabase: () => false,
      now: () => startedAt,
      open: async () => ({ client: stub.client, connectTimeMs: 4 }),
    });

    // 105 transactions over 60 seconds.
    expect(result.postgres.transactionsPerSecond).toEqual({ available: true, value: 1.75 });
    // 500 hits against 50 reads in the interval.
    expect(result.postgres.cacheHitRatioInterval).toEqual({ available: true, value: 90.91 });
    // The lifetime ratio is a different, much calmer number.
    expect(result.postgres.cacheHitRatioSinceReset).toEqual({ available: true, value: 95 });
  });

  it('refuses a delta across a statistics reset', () => {
    expect(delta(10, 100, true, 'Deadlocks in the interval')).toMatchObject({
      available: false,
      reason: 'counters_reset',
    });

    // Counters going backwards means a reset even when stats_reset did not move.
    expect(delta(10, 100, false, 'Deadlocks in the interval')).toMatchObject({
      available: false,
      reason: 'counters_reset',
    });
  });

  it('measures storage growth per day from the size change', async () => {
    const stub = stubClient();

    const result = await collectDatabase(target(), {
      credentials: { password: 'not-a-real-password' },
      previous: { ...previous, collectedAt: new Date('2026-09-11T10:00:00Z') },
      isOwnDatabase: () => false,
      now: () => new Date('2026-09-12T10:00:00Z'),
      open: async () => ({ client: stub.client, connectTimeMs: 1 }),
    });

    // 73,741,824 bytes over exactly one day.
    expect(result.resources.storageGrowthBytesPerDay).toEqual({
      available: true,
      value: 73_741_824,
    });
  });

  it('does not report a cache ratio when no blocks were touched', async () => {
    const stub = stubClient();

    const result = await collectDatabase(target(), {
      credentials: { password: 'not-a-real-password' },
      previous: { ...previous, blocksHit: STATS.blks_hit, blocksRead: STATS.blks_read },
      isOwnDatabase: () => false,
      now: () => new Date('2026-09-12T10:01:00Z'),
      open: async () => ({ client: stub.client, connectTimeMs: 1 }),
    });

    // Zero would read as "nothing was cached", the opposite of an idle database.
    expect(result.postgres.cacheHitRatioInterval).toMatchObject({ available: false });
  });
});

describe('connection safety', () => {
  it('verifies the server certificate unless told otherwise', () => {
    const config = buildClientConfig({
      host: 'db.example.com',
      port: 5432,
      databaseName: 'app',
      username: 'observability',
      sslEnabled: true,
      credentials: { password: 'secret' },
    });

    expect(config.ssl).toMatchObject({ rejectUnauthorized: true });
    expect(config.application_name).toBe('ai-db-observability-collector');
    expect(config.connectionTimeoutMillis).toBeGreaterThan(0);
  });

  it('honours an explicit opt-out and a private certificate authority', () => {
    const config = buildClientConfig({
      host: 'db.example.com',
      port: 5432,
      databaseName: 'app',
      username: 'observability',
      sslEnabled: true,
      credentials: { password: 'secret', rejectUnauthorized: false, ca: 'PEM' },
    });

    expect(config.ssl).toMatchObject({ rejectUnauthorized: false, ca: 'PEM' });
  });

  it('removes connection strings and the role name from an error', () => {
    const message = scrubConnectionError(
      'connection to postgresql://observability:hunter2@db:5432/app failed for user observability',
      { username: 'observability' }
    );

    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('observability');
    expect(message).toContain('[connection string]');
  });
});

describe('flattening a snapshot for storage', () => {
  it('stores an unavailable metric as a row with its reason', async () => {
    const { snapshot } = collectWith({
      server: { has_pg_monitor: false },
      connections: { hidden: 4 },
    });
    const rows = snapshotToRows(await snapshot);

    const active = rows.find((row) => row.metric === 'connections.active');
    expect(active).toMatchObject({
      value: null,
      reason: 'insufficient_privilege',
    });
    expect(active?.detail).toContain('pg_monitor');

    // A gap in the series and an unreadable metric must not look the same.
    const utilization = rows.find((row) => row.metric === 'connections.utilizationPercent');
    expect(utilization).toMatchObject({ value: 42, reason: null });
  });

  it('keeps text and boolean readings alongside the numbers', async () => {
    const { snapshot } = collectWith();
    const rows = snapshotToRows(await snapshot);

    expect(rows.find((row) => row.metric === 'health.serverVersion')).toMatchObject({
      textValue: '16.4',
      value: null,
    });
    expect(rows.find((row) => row.metric === 'health.inRecovery')).toMatchObject({
      value: 0,
      textValue: 'false',
    });
    expect(rows.find((row) => row.metric === 'health.responseTimeMs')?.value).toBeGreaterThan(0);
  });

  it('covers every metric the collector produced', async () => {
    const { snapshot } = collectWith();
    const result = await snapshot;
    const rows = snapshotToRows(result);

    // Nothing silently dropped between collection and storage.
    for (const { path } of eachMetric(result)) {
      expect(rows.some((row) => row.metric === path)).toBe(true);
    }
  });

  it('writes nothing for a database that was never reached', async () => {
    const result = await collectDatabase(target(), {
      credentials: { password: 'not-a-real-password' },
      isOwnDatabase: () => false,
      open: async () => {
        throw new Error('timeout');
      },
    });

    const rows = snapshotToRows(result);
    // Every row is an explicit "not read", and none claims a reading.
    expect(rows.every((row) => row.value === null)).toBe(true);
    expect(rows.every((row) => row.reason !== null)).toBe(true);
    expect(classifyOutcome(result)).toBe('failed');
  });
});
