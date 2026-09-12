import { acquireCollectorLock, type CollectorLock } from '@/lib/collector/lock';
import { collectDatabase } from './collect';
import { scrubConnectionError } from './connection';
import { listDatabaseTargets, recordCheck } from './repository';
import { loadDatabaseCredentials } from './service';
import { databaseMetricsStore } from './storage';
import type {
  CounterSample,
  DatabaseCollectionOutcome,
  DatabaseMetricsSink,
  DatabaseSnapshot,
  DatabaseTarget,
} from './types';

/**
 * A database collection run.
 *
 * The AI collector's shape, with one difference that matters: databases are
 * collected in parallel with each other but each target is visited once, never
 * concurrently. A monitored server that is already struggling must not have
 * several monitoring connections opened against it at the same moment.
 *
 * Every dependency is injectable, so the orchestration -- isolation between
 * targets, the lock, what gets recorded -- is testable without a network.
 */

export const DEFAULT_CONCURRENCY = 4;

/** Cap on how many problems a summary carries, so one outage cannot flood it. */
const MAX_PROBLEMS = 25;

/**
 * A separate advisory lock from the AI collector's.
 *
 * The two collectors talk to entirely different systems and have no reason to
 * block each other; sharing a lock would mean a slow provider delayed every
 * database check.
 */
export const DATABASE_COLLECTOR_LOCK_KEY = 4_726_302;

export interface DatabaseCollectionSummary {
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  /** False when another run held the lock, so this one did nothing. */
  ran: boolean;
  targets: number;
  success: number;
  partial: number;
  failed: number;
  skipped: number;
  metricsStored: number;
  byStatus: Record<string, number>;
  /** Messages worth showing an operator, already scrubbed of credentials. */
  problems: string[];
  snapshots: DatabaseSnapshot[];
}

export interface RunDatabaseCollectionOptions {
  organizationId?: string;
  concurrency?: number;
  /** Defaults to `database_metrics`; `discardingDatabaseSink` makes it a dry run. */
  sink?: DatabaseMetricsSink;
  logger?: (message: string) => void;
  now?: () => Date;

  // Seams, replaced in tests.
  listTargets?: (organizationId?: string) => Promise<DatabaseTarget[]>;
  loadCredentials?: (
    target: DatabaseTarget
  ) => Promise<{ credentials: { password: string } } | { error: string } | null>;
  collect?: typeof collectDatabase;
  saveCheck?: (snapshot: DatabaseSnapshot) => Promise<void>;
  acquireLock?: () => Promise<CollectorLock | null>;
}

/** Runs `worker` over `items`, at most `limit` at a time. */
async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const width = Math.max(1, Math.min(limit, queue.length));

  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const item = queue.shift();
        if (item === undefined) return;
        await worker(item);
      }
    })
  );
}

export async function runDatabaseCollection(
  options: RunDatabaseCollectionOptions = {}
): Promise<DatabaseCollectionSummary> {
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? (() => {});
  const sink = options.sink ?? databaseMetricsStore;
  const listTargets = options.listTargets ?? listDatabaseTargets;
  const loadCredentials =
    options.loadCredentials ??
    ((target: DatabaseTarget) => loadDatabaseCredentials(target.organizationId, target.databaseId));
  const collect = options.collect ?? collectDatabase;
  const acquireLock =
    options.acquireLock ?? (() => acquireCollectorLock(DATABASE_COLLECTOR_LOCK_KEY));
  const saveCheck =
    options.saveCheck ??
    ((snapshot: DatabaseSnapshot) =>
      recordCheck(
        snapshot.target.organizationId,
        snapshot.target.databaseId,
        snapshot.status,
        snapshot.error ?? null
      ));

  const startedAt = now();
  const summary: DatabaseCollectionSummary = {
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    ran: false,
    targets: 0,
    success: 0,
    partial: 0,
    failed: 0,
    skipped: 0,
    metricsStored: 0,
    byStatus: {},
    problems: [],
    snapshots: [],
  };

  const finish = (): DatabaseCollectionSummary => {
    const finishedAt = now();
    summary.finishedAt = finishedAt;
    summary.durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    return summary;
  };

  const note = (message: string) => {
    if (summary.problems.length < MAX_PROBLEMS) summary.problems.push(message);
  };

  const lock = await acquireLock();

  if (!lock) {
    // Not an error: the schedule fired while the previous run was still going.
    summary.problems.push('Another database collection is already running; this run did nothing.');
    logger('Collection skipped: another run holds the lock.');
    return finish();
  }

  summary.ran = true;

  try {
    const targets = await listTargets(options.organizationId);
    summary.targets = targets.length;

    if (targets.length === 0) {
      logger('No databases to collect from.');
      return finish();
    }

    await runPool(targets, options.concurrency ?? DEFAULT_CONCURRENCY, async (target) => {
      const label = `${target.name} (${target.databaseName})`;

      try {
        const loaded = await loadCredentials(target);

        if (loaded === null) {
          // Deleted between listing and collecting.
          summary.skipped += 1;
          summary.targets -= 1;
          return;
        }

        if ('error' in loaded) {
          // Usually a target encrypted with a retired encryption key.
          summary.failed += 1;
          note(`${label}: ${loaded.error}`);
          logger(`${label}: ${loaded.error}`);
          return;
        }

        const previous = (await sink.previousSample?.(target)) ?? null;

        const snapshot = await collect(target, {
          credentials: loaded.credentials as { password: string },
          previous,
          now,
        });

        summary.snapshots.push(snapshot);
        summary.byStatus[snapshot.status] = (summary.byStatus[snapshot.status] ?? 0) + 1;
        countOutcome(summary, snapshot.outcome);

        for (const message of snapshot.notes) note(message);
        if (snapshot.error) note(`${label}: ${snapshot.error}`);

        const written = await sink.write(snapshot);
        summary.metricsStored += written.stored;
        for (const message of written.notes) note(message);

        await saveCheck(snapshot);

        logger(
          `${label}: ${snapshot.outcome} (${snapshot.status}, ${snapshot.health.responseTimeMs}ms, ${written.stored} metrics stored)`
        );
      } catch (error) {
        /**
         * `collectDatabase` returns failures rather than throwing, so reaching
         * here means a defect. It is contained to one target: a crash on one
         * database must not stop the others being checked.
         */
        const detail = scrubConnectionError(
          error instanceof Error ? error.message : 'unexpected collector error',
          { username: target.username }
        );

        summary.failed += 1;
        note(`${label}: ${detail}`);
        logger(`${label}: crashed — ${detail}`);
      }
    });

    return finish();
  } finally {
    await lock.release();
  }
}

function countOutcome(
  summary: DatabaseCollectionSummary,
  outcome: DatabaseCollectionOutcome
): void {
  if (outcome === 'success') summary.success += 1;
  else if (outcome === 'partial') summary.partial += 1;
  else if (outcome === 'failed') summary.failed += 1;
  else summary.skipped += 1;
}

/** Re-exported so a sink implementation need not reach into `types`. */
export type { CounterSample };
