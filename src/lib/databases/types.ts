import type { Environment } from '@/lib/projects/schema';

/**
 * What a PostgreSQL target can tell us, and what it cannot.
 *
 * This mirrors the provider layer's `Metric` deliberately, but keeps its own
 * reasons rather than sharing `UnavailableReason`. The reasons are the point:
 * "the monitoring role lacks a privilege" is a `GRANT` away, "PostgreSQL does
 * not expose it" never will be, and "this is a rate and I have only one sample"
 * fixes itself on the next collection. Folding those into one word would leave
 * an operator unable to tell which of them they are looking at.
 */

export type DbUnavailableReason =
  /**
   * The monitoring role cannot see it. Almost always `pg_stat_activity`
   * columns for other users' backends, which is what `pg_monitor` grants.
   */
  | 'insufficient_privilege'
  /**
   * PostgreSQL has no such figure. CPU, memory and free disk are properties of
   * the host, not of the database, and no query returns them.
   */
  | 'not_exposed_by_postgres'
  /** An extension would provide it, and it is not installed. */
  | 'extension_required'
  /** A rate or a growth figure, which needs two samples to exist at all. */
  | 'needs_previous_sample'
  /** The statistics counters were reset between samples, so a delta would lie. */
  | 'counters_reset'
  /** The query was attempted and failed. */
  | 'query_error';

export type DbMetric<T> =
  | { readonly available: true; readonly value: T }
  | { readonly available: false; readonly reason: DbUnavailableReason; readonly detail: string };

export function value<T>(reading: T): DbMetric<T> {
  return { available: true, value: reading };
}

export function needsPrivilege<T>(detail: string): DbMetric<T> {
  return { available: false, reason: 'insufficient_privilege', detail };
}

export function notExposed<T>(detail: string): DbMetric<T> {
  return { available: false, reason: 'not_exposed_by_postgres', detail };
}

export function needsExtension<T>(detail: string): DbMetric<T> {
  return { available: false, reason: 'extension_required', detail };
}

export function needsPreviousSample<T>(detail: string): DbMetric<T> {
  return { available: false, reason: 'needs_previous_sample', detail };
}

export function countersReset<T>(detail: string): DbMetric<T> {
  return { available: false, reason: 'counters_reset', detail };
}

export function queryFailed<T>(detail: string): DbMetric<T> {
  return { available: false, reason: 'query_error', detail };
}

/** Reads a metric's value, or a fallback when it is unavailable. */
export function metricOr<T>(metric: DbMetric<T>, fallback: T): T {
  return metric.available ? metric.value : fallback;
}

/** One database to collect from, with everything needed to attribute it. */
export interface DatabaseTarget {
  organizationId: string;
  organizationName: string;
  projectId: string;
  projectName: string;
  databaseId: string;
  name: string;
  host: string;
  port: number;
  databaseName: string;
  username: string;
  sslEnabled: boolean;
  environment: Environment;
}

/** Availability, connection status and response time. */
export interface DatabaseHealth {
  /** Whether a connection was established and a query answered. */
  reachable: boolean;
  /** Connecting and running one trivial query, in milliseconds. */
  responseTimeMs: number;
  /** Just the connection handshake, which separates a slow network from a slow server. */
  connectTimeMs: number;
  serverVersion: DbMetric<string>;
  /** True on a physical replica, where writes and some figures differ. */
  inRecovery: DbMetric<boolean>;
  uptimeSeconds: DbMetric<number>;
  /** Already stripped of anything that could identify the credential. */
  error?: string;
}

export interface ResourceMetrics {
  databaseSizeBytes: DbMetric<number>;
  /** Every database on the server, which is what fills the disk. */
  clusterSizeBytes: DbMetric<number>;
  /** Bytes per day, from the change since the previous sample. */
  storageGrowthBytesPerDay: DbMetric<number>;
  cpuPercent: DbMetric<number>;
  memoryPercent: DbMetric<number>;
  diskFreeBytes: DbMetric<number>;
}

export interface ConnectionMetrics {
  /** Client backends across the whole server: the number `max_connections` caps. */
  current: DbMetric<number>;
  max: DbMetric<number>;
  /** Slots `max_connections` holds back for superusers, so they are not free capacity. */
  reservedForSuperusers: DbMetric<number>;
  active: DbMetric<number>;
  idle: DbMetric<number>;
  idleInTransaction: DbMetric<number>;
  /** Connections to this database specifically. */
  onThisDatabase: DbMetric<number>;
  /** `current` as a percentage of `max`, rounded to one decimal. */
  utilizationPercent: DbMetric<number>;
}

export interface QueryMetrics {
  active: DbMetric<number>;
  /** Running longer than the slow threshold. */
  slow: DbMetric<number>;
  /** Running longer than the long-running threshold: usually a problem already. */
  longRunning: DbMetric<number>;
  /** The longest currently-running statement, in seconds. */
  longestRunningSeconds: DbMetric<number>;
  /** Backends waiting on a lock right now. */
  blocked: DbMetric<number>;
  /** Lock requests not yet granted. */
  waitingLocks: DbMetric<number>;
  /**
   * Rolled-back transactions since the counters were last reset.
   *
   * The closest figure PostgreSQL keeps to "failed transactions": a rollback
   * may equally be an application choosing to roll back, so it is named for
   * what it counts rather than for what it is assumed to mean.
   */
  rolledBackTransactions: DbMetric<number>;
  /** Rolled back in the interval since the previous sample. */
  rollbacksInInterval: DbMetric<number>;
  deadlocks: DbMetric<number>;
  deadlocksInInterval: DbMetric<number>;
}

export interface PostgresMetrics {
  committedTransactions: DbMetric<number>;
  /** Commits plus rollbacks per second, measured across the interval. */
  transactionsPerSecond: DbMetric<number>;
  /**
   * Cache hit ratio for the interval since the previous sample -- what the
   * database is doing *now*.
   */
  cacheHitRatioInterval: DbMetric<number>;
  /**
   * Cache hit ratio over everything since the counters were reset. Kept
   * separate because it is a lifetime average: on a long-lived server it barely
   * moves, and reading it as the current ratio hides a cache that just went
   * cold.
   */
  cacheHitRatioSinceReset: DbMetric<number>;
  blocksHit: DbMetric<number>;
  blocksRead: DbMetric<number>;
  temporaryFiles: DbMetric<number>;
  temporaryBytes: DbMetric<number>;
  /** When the statistics counters were last reset, if ever. */
  statsResetAt: DbMetric<Date | null>;
  /** Whether `pg_stat_statements` is installed, for the query analytics phase. */
  statementStatsAvailable: DbMetric<boolean>;
}

/**
 * The counters a rate is computed from.
 *
 * Kept as a distinct shape because it is what the next phase has to store and
 * hand back: without the previous values, every rate in this module is
 * unavailable rather than wrong.
 */
export interface CounterSample {
  collectedAt: Date;
  xactCommit: number;
  xactRollback: number;
  blocksHit: number;
  blocksRead: number;
  deadlocks: number;
  databaseSizeBytes: number | null;
  statsResetAt: Date | null;
}

/** What the monitoring role is allowed to see. */
export interface RolePrivileges {
  isSuperuser: boolean;
  hasPgMonitor: boolean;
  hasReadAllStats: boolean;
  /** Client backends whose details are hidden from this role. */
  hiddenBackends: number;
}

export type DatabaseCollectionOutcome = 'success' | 'partial' | 'failed' | 'skipped';

/** Everything one collection learned about one database. */
export interface DatabaseSnapshot {
  target: DatabaseTarget;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  outcome: DatabaseCollectionOutcome;
  /** Availability and responsiveness, not a threshold judgement -- that is Phase 9. */
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

  health: DatabaseHealth;
  resources: ResourceMetrics;
  connections: ConnectionMetrics;
  queries: QueryMetrics;
  postgres: PostgresMetrics;

  privileges: RolePrivileges | null;
  /** The counters this run read, for the next run to compare against. */
  counters: CounterSample | null;

  /**
   * Advice an operator can act on: a missing grant, a superuser connection, a
   * target that is the dashboard's own database.
   */
  notes: string[];
  error?: string;
}

/** Why one metric is missing, flattened by dotted path for storage and display. */
export interface UnavailableNote {
  reason: DbUnavailableReason;
  detail: string;
}

/**
 * Where database metrics go.
 *
 * Phase 7 collects; Phase 8 defines the metric table and supplies the sink that
 * stores these snapshots. The seam is explicit so the collector can be built and
 * tested now against a schema that does not exist yet -- the same arrangement
 * that carried the AI collector from Phase 5 into Phase 6.
 */
export interface DatabaseMetricsSink {
  readonly name: string;
  /** Returns how many metric records were stored. */
  write(snapshot: DatabaseSnapshot): Promise<{ stored: number; notes: string[] }>;
  /**
   * The previous counter sample for a target, so rates can be computed.
   * Returning null is normal: the first collection has nothing to compare with.
   */
  previousSample?(target: DatabaseTarget): Promise<CounterSample | null>;
}
