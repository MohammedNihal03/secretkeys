import { getPool } from '@/lib/db/client';

/**
 * Health primitives for the dashboard itself.
 *
 * Phase 9 introduces the full health-evaluation engine for AI providers and
 * monitored databases. This module covers only the observability system's own
 * liveness, and defines the status vocabulary the later engine reuses.
 */

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

/**
 * Thresholds live here rather than being scattered across call sites, so the
 * configurable-threshold work in Phase 9 has a single place to replace.
 */
export const HEALTH_THRESHOLDS = {
  /** Dashboard database round-trip above this is slow enough to report as degraded. */
  dbLatencyDegradedMs: 500,
  /** A liveness probe that has not answered by now is treated as a failure. */
  dbProbeTimeoutMs: 5_000,

  /** A monitored database slower than this to answer a trivial query is degraded. */
  monitoredDbLatencyDegradedMs: 1_000,

  /** An active statement running longer than this counts as slow. */
  slowQuerySeconds: 5,

  /**
   * And longer than this as long-running: usually already a problem, not merely
   * a slow query.
   */
  longRunningQuerySeconds: 60,
} as const;

export interface CheckResult {
  status: HealthStatus;
  /** Round-trip duration of the probe in milliseconds. */
  latencyMs: number;
  /** Present only when the check did not succeed. Never contains credentials. */
  error?: string;
}

export interface HealthReport {
  status: HealthStatus;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
  checks: {
    database: CheckResult;
  };
}

/** Rejects if `promise` has not settled within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verifies the dashboard can reach its own database.
 *
 * Never throws: a failure is a reportable state, not an exception. Postgres
 * error messages can echo connection parameters, so only the message text is
 * surfaced and never the connection string.
 */
export async function checkDatabase(): Promise<CheckResult> {
  const startedAt = performance.now();

  try {
    const pool = getPool();
    await withTimeout(pool.query('select 1'), HEALTH_THRESHOLDS.dbProbeTimeoutMs, 'database probe');

    const latencyMs = Math.round(performance.now() - startedAt);

    return {
      status: latencyMs > HEALTH_THRESHOLDS.dbLatencyDegradedMs ? 'degraded' : 'healthy',
      latencyMs,
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : 'unknown database error',
    };
  }
}

/** Worst status wins, so a single failing dependency is never masked by healthy ones. */
export function aggregateStatus(statuses: HealthStatus[]): HealthStatus {
  const precedence: HealthStatus[] = ['unhealthy', 'degraded', 'unknown', 'healthy'];
  return precedence.find((candidate) => statuses.includes(candidate)) ?? 'unknown';
}

export async function getHealthReport(): Promise<HealthReport> {
  const database = await checkDatabase();

  return {
    status: aggregateStatus([database.status]),
    version: process.env.npm_package_version ?? '0.0.0',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    checks: { database },
  };
}
