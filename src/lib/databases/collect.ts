import { getSqlState, PG_ERROR } from '@/lib/db/errors';
import { HEALTH_THRESHOLDS } from '@/lib/health';
import {
  CONNECTION_LIMITS,
  describeConnectionFailure,
  isDashboardsOwnDatabase,
  openMonitoringConnection,
  scrubConnectionError,
  type DatabaseCredentials,
} from './connection';
import {
  ACTIVITY_SQL,
  CLUSTER_SIZE_SQL,
  CONNECTIONS_SQL,
  DATABASE_SIZE_SQL,
  DATABASE_STATS_SQL,
  LOCKS_SQL,
  SERVER_INFO_SQL,
  type ActivityRow,
  type ClusterSizeRow,
  type ConnectionsRow,
  type DatabaseSizeRow,
  type DatabaseStatsRow,
  type LocksRow,
  type ServerInfoRow,
} from './queries';
import {
  countersReset,
  needsExtension,
  needsPreviousSample,
  needsPrivilege,
  notExposed,
  queryFailed,
  tooExpensive,
  value,
  type ConnectionMetrics,
  type CounterSample,
  type DatabaseCollectionOutcome,
  type DatabaseHealth,
  type DatabaseSnapshot,
  type DatabaseTarget,
  type DbMetric,
  type PostgresMetrics,
  type QueryMetrics,
  type ResourceMetrics,
  type RolePrivileges,
} from './types';

/**
 * Collecting from one PostgreSQL database.
 *
 * Never throws for a problem with the target: an unreachable database is a
 * result to record, the same contract the AI collector keeps. The connection is
 * opened once, every statistic is read over it, and it is closed again whatever
 * happens.
 *
 * A single failing query never costs the rest. `pg_locks` being refused should
 * lose lock counts, not connection counts -- so each read is guarded on its own
 * and records its own reason for being missing.
 */

/** The part of `pg.Client` this module uses, so tests need no server. */
export interface MonitoringClient {
  query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

export interface CollectDatabaseDeps {
  credentials: DatabaseCredentials;
  /** The previous run's counters, which is what makes a rate possible. */
  previous?: CounterSample | null;
  open?: (input: {
    host: string;
    port: number;
    databaseName: string;
    username: string;
    sslEnabled: boolean;
    credentials: DatabaseCredentials;
  }) => Promise<{ client: MonitoringClient; connectTimeMs: number }>;
  now?: () => Date;
  /** Only for the self-monitoring note; injected so tests need no environment. */
  isOwnDatabase?: (target: DatabaseTarget) => boolean;
  /**
   * Sum the size of every database on the server. Off by default because it
   * walks each database's directory -- seconds, not milliseconds.
   */
  includeClusterSize?: boolean;
}

const NO_CPU_DETAIL =
  'PostgreSQL does not report host CPU. It needs an operating-system agent, or the metrics API of a managed provider.';
const NO_MEMORY_DETAIL =
  'PostgreSQL does not report host memory. Shared buffer usage is visible, but total memory is a property of the machine.';
const NO_DISK_DETAIL =
  'PostgreSQL does not report free disk space. Database and cluster sizes below are what it does know.';

const PRIVILEGE_DETAIL =
  'The monitoring role cannot see other users’ backends. Run GRANT pg_monitor TO <role> on the server.';

/** A read that records why it failed instead of ending the collection. */
async function attempt<T>(
  client: MonitoringClient,
  sql: string,
  values?: unknown[]
): Promise<{ row: T } | { error: string }> {
  try {
    const result = await client.query<T>(sql, values);
    const row = result.rows[0];

    return row === undefined ? { error: 'The server returned no row.' } : { row };
  } catch (error) {
    if (getSqlState(error) === PG_ERROR.queryCanceled) {
      /**
       * The collector's own `statement_timeout` stopped it. Said in those
       * terms, because "canceling statement due to statement timeout" reads as
       * a problem with the monitored database rather than a limit we imposed.
       */
      return {
        error: `The read took longer than the collector's ${CONNECTION_LIMITS.statementTimeoutMs}ms limit and was cancelled.`,
      };
    }

    return { error: error instanceof Error ? error.message : 'query failed' };
  }
}

/**
 * Whether `pg_stat_activity`'s per-backend columns can be trusted.
 *
 * Privilege is the reason they would be hidden, but not the only way to have
 * full visibility: a role that owns every connection sees all of them without
 * `pg_monitor`. So the test is "is anything actually hidden", with the grant
 * reported as the fix when something is.
 */
export function canSeeAllBackends(privileges: RolePrivileges): boolean {
  return (
    privileges.isSuperuser ||
    privileges.hasPgMonitor ||
    privileges.hasReadAllStats ||
    privileges.hiddenBackends === 0
  );
}

/** A counter delta, refusing to produce one across a statistics reset. */
export function delta(
  current: number,
  previous: number | undefined,
  resetChanged: boolean,
  label: string
): DbMetric<number> {
  if (previous === undefined) {
    return needsPreviousSample(`${label} needs two samples; this is the first for this database.`);
  }

  if (resetChanged) {
    return countersReset(
      `The statistics counters were reset since the last collection, so ${label.toLowerCase()} cannot be measured across it.`
    );
  }

  if (current < previous) {
    /**
     * Counters only go up. Going down means the server restarted with a fresh
     * set, which `stats_reset` does not always record.
     */
    return countersReset(
      `The counters went backwards since the last collection, which means they were reset; ${label.toLowerCase()} was not measured.`
    );
  }

  return value(current - previous);
}

function round(figure: number, places = 1): number {
  const factor = 10 ** places;
  return Math.round(figure * factor) / factor;
}

export async function collectDatabase(
  target: DatabaseTarget,
  deps: CollectDatabaseDeps
): Promise<DatabaseSnapshot> {
  const now = deps.now ?? (() => new Date());
  const open = deps.open ?? openMonitoringConnection;
  const isOwn = deps.isOwnDatabase ?? isDashboardsOwnDatabase;
  const startedAt = now();

  const notes: string[] = [];

  if (isOwn(target)) {
    notes.push(
      `${target.name} is the dashboard’s own database. Its figures include this application’s own connections and queries.`
    );
  }

  let opened: { client: MonitoringClient; connectTimeMs: number };

  try {
    opened = await open({
      host: target.host,
      port: target.port,
      databaseName: target.databaseName,
      username: target.username,
      sslEnabled: target.sslEnabled,
      credentials: deps.credentials,
    });
  } catch (error) {
    // Named rather than echoed: `sorry, too many clients already` is not a
    // next step, and it is the failure an operator most needs to recognise.
    const detail = describeConnectionFailure(error, { username: target.username });
    const finishedAt = now();

    return unreachableSnapshot(target, startedAt, finishedAt, detail, notes);
  }

  const { client, connectTimeMs } = opened;

  try {
    const probeStartedAt = performance.now();
    const info = await attempt<ServerInfoRow>(client, SERVER_INFO_SQL);
    const probeMs = Math.round(performance.now() - probeStartedAt);

    if ('error' in info) {
      /**
       * Connected, but the server would not answer the most basic catalogue
       * query. That is a reachable database we cannot monitor -- distinct from
       * one that is down, and recorded as such.
       */
      const finishedAt = now();
      const detail = scrubConnectionError(info.error, { username: target.username });

      return {
        ...unreachableSnapshot(target, startedAt, finishedAt, detail, notes),
        status: 'degraded',
        health: {
          reachable: true,
          responseTimeMs: connectTimeMs + probeMs,
          connectTimeMs,
          serverVersion: queryFailed(detail),
          inRecovery: queryFailed(detail),
          uptimeSeconds: queryFailed(detail),
          error: detail,
        },
      };
    }

    const server = info.row;
    const responseTimeMs = connectTimeMs + probeMs;

    /**
     * One statement at a time. A `pg.Client` is a single connection, so issuing
     * these together would queue them on the wire anyway -- and the driver
     * deprecates overlapping queries on one client. Sequential also keeps the
     * footprint on the monitored server to exactly one backend doing one thing.
     */
    const connectionsResult = await attempt<ConnectionsRow>(client, CONNECTIONS_SQL);
    const activityResult = await attempt<ActivityRow>(client, ACTIVITY_SQL, [
      HEALTH_THRESHOLDS.slowQuerySeconds,
      HEALTH_THRESHOLDS.longRunningQuerySeconds,
    ]);
    const locksResult = await attempt<LocksRow>(client, LOCKS_SQL);
    const statsResult = await attempt<DatabaseStatsRow>(client, DATABASE_STATS_SQL);
    const sizeResult = await attempt<DatabaseSizeRow>(client, DATABASE_SIZE_SQL);
    const clusterSizeResult = deps.includeClusterSize
      ? await attempt<ClusterSizeRow>(client, CLUSTER_SIZE_SQL)
      : null;

    const privileges: RolePrivileges = {
      isSuperuser: server.is_superuser,
      hasPgMonitor: server.has_pg_monitor,
      hasReadAllStats: server.has_read_all_stats,
      hiddenBackends: 'row' in connectionsResult ? connectionsResult.row.hidden : 0,
    };

    const visible = canSeeAllBackends(privileges);

    if (!visible) {
      notes.push(
        `${target.name}: ${privileges.hiddenBackends} connection(s) are hidden from the monitoring role, so query and connection detail is incomplete. ${PRIVILEGE_DETAIL}`
      );
    }

    if (privileges.isSuperuser) {
      notes.push(
        `${target.name} is monitored with a superuser. The collector only reads statistics — pg_monitor is enough, and safer.`
      );
    }

    const health: DatabaseHealth = {
      reachable: true,
      responseTimeMs,
      connectTimeMs,
      serverVersion: value(server.server_version),
      inRecovery: value(server.in_recovery),
      uptimeSeconds: value(Math.round(server.uptime_seconds)),
    };

    const stats = 'row' in statsResult ? statsResult.row : null;
    const statsError = 'error' in statsResult ? statsResult.error : null;
    const size = 'row' in sizeResult ? sizeResult.row : null;
    const sizeError = 'error' in sizeResult ? sizeResult.error : null;
    const clusterSize =
      clusterSizeResult && 'row' in clusterSizeResult ? clusterSizeResult.row : null;
    const clusterSizeError =
      clusterSizeResult && 'error' in clusterSizeResult ? clusterSizeResult.error : null;

    const counters: CounterSample | null = stats
      ? {
          collectedAt: startedAt,
          xactCommit: stats.xact_commit,
          xactRollback: stats.xact_rollback,
          blocksHit: stats.blks_hit,
          blocksRead: stats.blks_read,
          deadlocks: stats.deadlocks,
          databaseSizeBytes: size?.database_size_bytes ?? null,
          statsResetAt: stats.stats_reset,
        }
      : null;

    const previous = deps.previous ?? null;
    const resetChanged =
      previous !== null &&
      counters !== null &&
      String(previous.statsResetAt?.getTime() ?? 'never') !==
        String(counters.statsResetAt?.getTime() ?? 'never');

    const resources = buildResources({
      size,
      sizeError,
      clusterSize,
      clusterSizeError,
      clusterSizeRequested: deps.includeClusterSize ?? false,
      counters,
      previous,
      resetChanged,
      elapsedSeconds: elapsedBetween(previous, startedAt),
    });

    const connections = buildConnections({
      row: 'row' in connectionsResult ? connectionsResult.row : null,
      error: 'error' in connectionsResult ? connectionsResult.error : null,
      server,
      visible,
    });

    const queries = buildQueries({
      activity: 'row' in activityResult ? activityResult.row : null,
      activityError: 'error' in activityResult ? activityResult.error : null,
      locks: 'row' in locksResult ? locksResult.row : null,
      locksError: 'error' in locksResult ? locksResult.error : null,
      stats,
      statsError,
      previous,
      counters,
      resetChanged,
      visible,
    });

    const postgres = buildPostgres({
      stats,
      statsError,
      previous,
      counters,
      resetChanged,
      elapsedSeconds: elapsedBetween(previous, startedAt),
      hasStatementStats: server.has_statement_stats,
    });

    const finishedAt = now();

    const snapshot: DatabaseSnapshot = {
      target,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      outcome: 'success',
      status:
        responseTimeMs > HEALTH_THRESHOLDS.monitoredDbLatencyDegradedMs ? 'degraded' : 'healthy',
      health,
      resources,
      connections,
      queries,
      postgres,
      privileges,
      counters,
      notes,
    };

    snapshot.outcome = classifyOutcome(snapshot);
    return snapshot;
  } finally {
    // A leaked connection on a monitored server is the worst thing this tool
    // could do to it.
    await client.end().catch(() => {});
  }
}

function elapsedBetween(previous: CounterSample | null, at: Date): number {
  if (!previous) return 0;
  return Math.max(0, (at.getTime() - previous.collectedAt.getTime()) / 1000);
}

function unreachableSnapshot(
  target: DatabaseTarget,
  startedAt: Date,
  finishedAt: Date,
  detail: string,
  notes: string[]
): DatabaseSnapshot {
  const unreachable = <T>(): DbMetric<T> =>
    queryFailed<T>('The database could not be reached, so nothing was read.');

  return {
    target,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    outcome: 'failed',
    status: 'unhealthy',
    health: {
      reachable: false,
      responseTimeMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      connectTimeMs: 0,
      serverVersion: unreachable(),
      inRecovery: unreachable(),
      uptimeSeconds: unreachable(),
      error: detail,
    },
    resources: {
      databaseSizeBytes: unreachable(),
      clusterSizeBytes: unreachable(),
      storageGrowthBytesPerDay: unreachable(),
      cpuPercent: notExposed(NO_CPU_DETAIL),
      memoryPercent: notExposed(NO_MEMORY_DETAIL),
      diskFreeBytes: notExposed(NO_DISK_DETAIL),
    },
    connections: {
      current: unreachable(),
      max: unreachable(),
      reservedForSuperusers: unreachable(),
      active: unreachable(),
      idle: unreachable(),
      idleInTransaction: unreachable(),
      onThisDatabase: unreachable(),
      utilizationPercent: unreachable(),
    },
    queries: {
      active: unreachable(),
      slow: unreachable(),
      longRunning: unreachable(),
      longestRunningSeconds: unreachable(),
      blocked: unreachable(),
      waitingLocks: unreachable(),
      rolledBackTransactions: unreachable(),
      rollbacksInInterval: unreachable(),
      deadlocks: unreachable(),
      deadlocksInInterval: unreachable(),
    },
    postgres: {
      committedTransactions: unreachable(),
      transactionsPerSecond: unreachable(),
      cacheHitRatioInterval: unreachable(),
      cacheHitRatioSinceReset: unreachable(),
      blocksHit: unreachable(),
      blocksRead: unreachable(),
      temporaryFiles: unreachable(),
      temporaryBytes: unreachable(),
      statsResetAt: unreachable(),
      statementStatsAvailable: unreachable(),
    },
    privileges: null,
    counters: null,
    notes,
    error: detail,
  };
}

function buildResources(input: {
  size: DatabaseSizeRow | null;
  sizeError: string | null;
  clusterSize: ClusterSizeRow | null;
  clusterSizeError: string | null;
  clusterSizeRequested: boolean;
  counters: CounterSample | null;
  previous: CounterSample | null;
  resetChanged: boolean;
  elapsedSeconds: number;
}): ResourceMetrics {
  const {
    size,
    sizeError,
    clusterSize,
    clusterSizeError,
    clusterSizeRequested,
    counters,
    previous,
    elapsedSeconds,
  } = input;

  let growth: DbMetric<number>;

  if (!previous || previous.databaseSizeBytes === null) {
    growth = needsPreviousSample(
      'Storage growth needs two samples; this is the first size recorded for this database.'
    );
  } else if (counters?.databaseSizeBytes == null) {
    growth = queryFailed('The current size could not be read, so growth could not be measured.');
  } else if (elapsedSeconds <= 0) {
    growth = needsPreviousSample('No time has passed since the previous sample.');
  } else {
    const perDay =
      ((counters.databaseSizeBytes - previous.databaseSizeBytes) / elapsedSeconds) * 86_400;
    growth = value(Math.round(perDay));
  }

  return {
    databaseSizeBytes: size
      ? value(Math.round(size.database_size_bytes))
      : queryFailed(sizeError ?? 'The database size could not be read.'),
    clusterSizeBytes: !clusterSizeRequested
      ? tooExpensive(
          'Summing every database on the server walks each one’s directory, which is too slow to run on a schedule. This database’s own size is above.'
        )
      : clusterSize && clusterSize.cluster_size_bytes !== null
        ? value(Math.round(clusterSize.cluster_size_bytes))
        : clusterSize
          ? needsPrivilege(
              'The role cannot connect to any other database on this server, so no cluster total could be summed.'
            )
          : queryFailed(clusterSizeError ?? 'The cluster size could not be read.'),
    storageGrowthBytesPerDay: growth,
    // Host metrics, permanently. Said plainly rather than left blank.
    cpuPercent: notExposed(NO_CPU_DETAIL),
    memoryPercent: notExposed(NO_MEMORY_DETAIL),
    diskFreeBytes: notExposed(NO_DISK_DETAIL),
  };
}

function buildConnections(input: {
  row: ConnectionsRow | null;
  error: string | null;
  server: ServerInfoRow;
  visible: boolean;
}): ConnectionMetrics {
  const { row, error, server, visible } = input;

  const failed = <T>(): DbMetric<T> =>
    queryFailed<T>(error ?? 'Connection statistics could not be read.');

  const hidden = <T>(): DbMetric<T> => needsPrivilege<T>(PRIVILEGE_DETAIL);

  if (!row) {
    return {
      current: failed(),
      max: value(server.max_connections),
      reservedForSuperusers: value(server.reserved_connections),
      active: failed(),
      idle: failed(),
      idleInTransaction: failed(),
      onThisDatabase: failed(),
      utilizationPercent: failed(),
    };
  }

  return {
    // The row count is visible without privilege even when the details are not.
    current: value(row.total),
    max: value(server.max_connections),
    reservedForSuperusers: value(server.reserved_connections),
    active: visible ? value(row.active) : hidden(),
    idle: visible ? value(row.idle) : hidden(),
    idleInTransaction: visible ? value(row.idle_in_transaction) : hidden(),
    onThisDatabase: value(row.on_this_database),
    utilizationPercent:
      server.max_connections > 0
        ? value(round((row.total / server.max_connections) * 100))
        : queryFailed('max_connections was not a usable number.'),
  };
}

function buildQueries(input: {
  activity: ActivityRow | null;
  activityError: string | null;
  locks: LocksRow | null;
  locksError: string | null;
  stats: DatabaseStatsRow | null;
  statsError: string | null;
  previous: CounterSample | null;
  counters: CounterSample | null;
  resetChanged: boolean;
  visible: boolean;
}): QueryMetrics {
  const { activity, activityError, locks, locksError, stats, statsError, visible } = input;

  const activityMetric = (reading: number | undefined): DbMetric<number> => {
    if (!activity) return queryFailed(activityError ?? 'Activity could not be read.');
    if (!visible) return needsPrivilege(PRIVILEGE_DETAIL);
    return value(reading ?? 0);
  };

  const statsMetric = (reading: number | undefined): DbMetric<number> =>
    stats ? value(reading ?? 0) : queryFailed(statsError ?? 'Database statistics were not read.');

  return {
    active: activityMetric(activity?.active),
    slow: activityMetric(activity?.slow),
    longRunning: activityMetric(activity?.long_running),
    longestRunningSeconds: activity
      ? visible
        ? value(round(activity.longest_running_seconds, 2))
        : needsPrivilege(PRIVILEGE_DETAIL)
      : queryFailed(activityError ?? 'Activity could not be read.'),
    blocked: activityMetric(activity?.blocked),
    waitingLocks: locks
      ? value(locks.waiting)
      : queryFailed(locksError ?? 'Locks could not be read.'),
    rolledBackTransactions: statsMetric(stats?.xact_rollback),
    rollbacksInInterval: delta(
      stats?.xact_rollback ?? 0,
      input.previous?.xactRollback,
      input.resetChanged,
      'Rollbacks in the interval'
    ),
    deadlocks: statsMetric(stats?.deadlocks),
    deadlocksInInterval: delta(
      stats?.deadlocks ?? 0,
      input.previous?.deadlocks,
      input.resetChanged,
      'Deadlocks in the interval'
    ),
  };
}

function buildPostgres(input: {
  stats: DatabaseStatsRow | null;
  statsError: string | null;
  previous: CounterSample | null;
  counters: CounterSample | null;
  resetChanged: boolean;
  elapsedSeconds: number;
  hasStatementStats: boolean;
}): PostgresMetrics {
  const { stats, statsError, previous, resetChanged, elapsedSeconds, hasStatementStats } = input;

  const failed = <T>(): DbMetric<T> =>
    queryFailed<T>(statsError ?? 'Database statistics were not read.');

  if (!stats) {
    return {
      committedTransactions: failed(),
      transactionsPerSecond: failed(),
      cacheHitRatioInterval: failed(),
      cacheHitRatioSinceReset: failed(),
      blocksHit: failed(),
      blocksRead: failed(),
      temporaryFiles: failed(),
      temporaryBytes: failed(),
      statsResetAt: failed(),
      statementStatsAvailable: value(hasStatementStats),
    };
  }

  const transactions = stats.xact_commit + stats.xact_rollback;
  const previousTransactions = previous ? previous.xactCommit + previous.xactRollback : undefined;
  const transactionDelta = delta(
    transactions,
    previousTransactions,
    resetChanged,
    'Transaction rate'
  );

  let perSecond: DbMetric<number>;
  if (!transactionDelta.available) {
    perSecond = transactionDelta;
  } else if (elapsedSeconds <= 0) {
    perSecond = needsPreviousSample('No time has passed since the previous sample.');
  } else {
    perSecond = value(round(transactionDelta.value / elapsedSeconds, 2));
  }

  const totalBlocks = stats.blks_hit + stats.blks_read;

  const hitDelta = delta(stats.blks_hit, previous?.blocksHit, resetChanged, 'Cache hit ratio');
  const readDelta = delta(stats.blks_read, previous?.blocksRead, resetChanged, 'Cache hit ratio');

  let intervalRatio: DbMetric<number>;
  if (!hitDelta.available) {
    intervalRatio = hitDelta;
  } else if (!readDelta.available) {
    intervalRatio = readDelta;
  } else if (hitDelta.value + readDelta.value === 0) {
    /**
     * No blocks were touched at all. A ratio of zero would read as "nothing was
     * cached", which is the opposite of an idle database.
     */
    intervalRatio = needsPreviousSample(
      'No blocks were read or hit since the last collection, so there is no ratio to report.'
    );
  } else {
    intervalRatio = value(round((hitDelta.value / (hitDelta.value + readDelta.value)) * 100, 2));
  }

  return {
    committedTransactions: value(stats.xact_commit),
    transactionsPerSecond: perSecond,
    cacheHitRatioInterval: intervalRatio,
    cacheHitRatioSinceReset:
      totalBlocks > 0
        ? value(round((stats.blks_hit / totalBlocks) * 100, 2))
        : needsPreviousSample('No blocks have been read since the counters were reset.'),
    blocksHit: value(stats.blks_hit),
    blocksRead: value(stats.blks_read),
    temporaryFiles: value(stats.temp_files),
    temporaryBytes: value(stats.temp_bytes),
    statsResetAt: value(stats.stats_reset),
    statementStatsAvailable: hasStatementStats
      ? value(true)
      : needsExtension(
          'pg_stat_statements is not installed, so per-statement timings are unavailable.'
        ),
  };
}

/**
 * Every metric in the snapshot, flattened by dotted path.
 *
 * One place that knows the shape, so storage, display and outcome rules cannot
 * drift apart as metrics are added.
 */
export function eachMetric(
  snapshot: DatabaseSnapshot
): { path: string; metric: DbMetric<unknown> }[] {
  const groups: [string, Record<string, unknown>][] = [
    ['health', snapshot.health as unknown as Record<string, unknown>],
    ['resources', snapshot.resources as unknown as Record<string, unknown>],
    ['connections', snapshot.connections as unknown as Record<string, unknown>],
    ['queries', snapshot.queries as unknown as Record<string, unknown>],
    ['postgres', snapshot.postgres as unknown as Record<string, unknown>],
  ];

  const found: { path: string; metric: DbMetric<unknown> }[] = [];

  for (const [group, fields] of groups) {
    for (const [name, candidate] of Object.entries(fields)) {
      if (typeof candidate === 'object' && candidate !== null && 'available' in candidate) {
        found.push({ path: `${group}.${name}`, metric: candidate as DbMetric<unknown> });
      }
    }
  }

  return found;
}

/**
 * Which reasons make a collection partial.
 *
 * A metric PostgreSQL simply does not expose is not a defect, and a rate that
 * needs a second sample fixes itself on the next run; reporting either as
 * partial would make a healthy setup permanently amber. A missing grant and a
 * failed query are different -- both are something an operator can fix.
 */
export function classifyOutcome(snapshot: DatabaseSnapshot): DatabaseCollectionOutcome {
  if (!snapshot.health.reachable) return 'failed';

  const degrading = eachMetric(snapshot).some(
    ({ metric }) =>
      !metric.available &&
      (metric.reason === 'insufficient_privilege' || metric.reason === 'query_error')
  );

  return degrading ? 'partial' : 'success';
}
