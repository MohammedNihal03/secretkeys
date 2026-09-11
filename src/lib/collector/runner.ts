import { loadCredentialForUse } from '@/lib/credentials/service';
import { scrubSecrets } from '@/lib/providers/http';
import { getAdapter } from '@/lib/providers/registry';
import type { AiProviderType, ProviderCredential, UsageWindow } from '@/lib/providers/types';
import { collectTarget } from './collect-target';
import { acquireCollectorLock, type CollectorLock } from './lock';
import { recordCollectorRun, updateCredentialCheck } from './runs-repository';
import type { RetryOptions } from './retry';
import { discardingUsageSink } from './sink';
import { listCollectionTargets } from './targets';
import type {
  CollectionSummary,
  CollectionTarget,
  CollectorRunRecord,
  ProviderSummary,
  TargetCollection,
  UsageSink,
} from './types';

/**
 * The collection run: the "Scheduler → Collector → Adapters → Normalized
 * metrics → Storage" pipeline from the build plan.
 *
 * Every external dependency is injectable, which is what makes the
 * orchestration -- isolation between providers, retry pressure, the lock,
 * what gets recorded -- testable without a network or a database.
 */

export const DEFAULT_CONCURRENCY = 4;

/**
 * How far back usage is requested.
 *
 * More than one day because providers finalise usage late: yesterday's figures
 * can still change after midnight. Overlapping windows mean the Phase 6 sink
 * must upsert rather than append -- re-collecting the same window must correct
 * rows, not duplicate them.
 */
export const DEFAULT_USAGE_WINDOW_DAYS = 2;

/** Cap on how many problems a summary carries, so one outage cannot flood it. */
const MAX_PROBLEMS = 25;

export interface RunCollectionOptions {
  /** Narrow to one organization. Omit to collect for all of them. */
  organizationId?: string;
  concurrency?: number;
  usageWindowDays?: number;
  sink?: UsageSink;
  retry?: RetryOptions;
  logger?: (message: string) => void;
  now?: () => Date;

  // Seams, replaced in tests.
  listTargets?: (organizationId?: string) => Promise<CollectionTarget[]>;
  loadCredential?: (
    target: CollectionTarget
  ) => Promise<ProviderCredential | { error: string } | null>;
  adapterFor?: (type: AiProviderType) => ReturnType<typeof getAdapter>;
  recordRun?: (record: CollectorRunRecord) => Promise<void>;
  saveCredentialCheck?: (
    target: CollectionTarget,
    outcome: 'valid' | 'invalid' | 'unverified',
    detail: string | null
  ) => Promise<void>;
  acquireLock?: () => Promise<CollectorLock | null>;
}

/** Loads and decrypts a credential for one target. */
async function defaultLoadCredential(
  target: CollectionTarget
): Promise<ProviderCredential | { error: string } | null> {
  const loaded = await loadCredentialForUse(target.organizationId, target.apiKeyId);

  if (!loaded) return null;
  if ('error' in loaded) return loaded;

  return loaded.credential;
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

function emptyProviderSummary(): ProviderSummary {
  return { targets: 0, success: 0, partial: 0, failed: 0, usageEntries: 0 };
}

export async function runCollection(
  options: RunCollectionOptions = {}
): Promise<CollectionSummary> {
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? (() => {});
  const sink = options.sink ?? discardingUsageSink;
  const listTargets = options.listTargets ?? listCollectionTargets;
  const loadCredential = options.loadCredential ?? defaultLoadCredential;
  const adapterFor = options.adapterFor ?? getAdapter;
  const recordRun = options.recordRun ?? recordCollectorRun;
  const acquireLock = options.acquireLock ?? acquireCollectorLock;
  const saveCredentialCheck =
    options.saveCredentialCheck ??
    ((target, outcome, detail) =>
      updateCredentialCheck(target.organizationId, target.apiKeyId, outcome, detail));

  const startedAt = now();
  const summary: CollectionSummary = {
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    ran: false,
    targets: 0,
    success: 0,
    partial: 0,
    failed: 0,
    skipped: 0,
    usageEntries: 0,
    usagePersisted: 0,
    byProvider: {},
    problems: [],
  };

  const finish = (): CollectionSummary => {
    const finishedAt = now();
    summary.finishedAt = finishedAt;
    summary.durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    return summary;
  };

  const lock = await acquireLock();

  if (!lock) {
    // Not an error: the schedule fired while the previous run was still going.
    summary.problems.push('Another collection is already running; this run did nothing.');
    logger('Collection skipped: another run holds the lock.');
    return finish();
  }

  summary.ran = true;

  try {
    const targets = await listTargets(options.organizationId);
    summary.targets = targets.length;

    if (targets.length === 0) {
      logger('No credentials to collect from.');
      return finish();
    }

    const windowEnd = now();
    const days = options.usageWindowDays ?? DEFAULT_USAGE_WINDOW_DAYS;
    const window: UsageWindow = {
      start: new Date(windowEnd.getTime() - days * 24 * 60 * 60 * 1000),
      end: windowEnd,
    };

    /**
     * Grouped by provider, then each group run in sequence while groups run in
     * parallel. One provider therefore sees one request at a time, which keeps
     * the collector from triggering the very rate limits it is measuring, while
     * a slow provider cannot hold up the others.
     */
    const groups = new Map<AiProviderType, CollectionTarget[]>();
    for (const target of targets) {
      const group = groups.get(target.providerType) ?? [];
      group.push(target);
      groups.set(target.providerType, group);
    }

    const note = (message: string) => {
      if (summary.problems.length < MAX_PROBLEMS) summary.problems.push(message);
    };

    const record = async (
      target: CollectionTarget,
      partial: Partial<CollectorRunRecord> & Pick<CollectorRunRecord, 'outcome' | 'providerStatus'>
    ) => {
      const finishedAt = now();
      await recordRun({
        organizationId: target.organizationId,
        apiKeyId: target.apiKeyId,
        providerId: target.providerId,
        startedAt: finishedAt,
        finishedAt,
        durationMs: 0,
        latencyMs: null,
        rateLimited: false,
        attempts: 0,
        usageWindowStart: null,
        usageWindowEnd: null,
        usageEntryCount: 0,
        usagePersistedCount: 0,
        unavailable: null,
        error: null,
        ...partial,
      });
    };

    await runPool(
      Array.from(groups.values()),
      options.concurrency ?? DEFAULT_CONCURRENCY,
      async (group) => {
        for (const target of group) {
          const providerSummary = summary.byProvider[target.providerName] ?? emptyProviderSummary();
          providerSummary.targets += 1;
          summary.byProvider[target.providerName] = providerSummary;

          const label = `${target.providerName} · ${target.keyName}`;

          try {
            const credential = await loadCredential(target);

            if (credential === null) {
              // Deleted between listing and collecting.
              summary.skipped += 1;
              providerSummary.targets -= 1;
              continue;
            }

            if ('error' in credential) {
              // Usually a key encrypted with a retired encryption key.
              summary.failed += 1;
              providerSummary.failed += 1;
              note(`${label}: ${credential.error}`);
              await record(target, {
                outcome: 'failed',
                providerStatus: 'unknown',
                error: credential.error,
              });
              continue;
            }

            const collection: TargetCollection = await collectTarget(target, {
              adapter: adapterFor(target.providerType),
              credential,
              window,
              retry: options.retry,
              now,
            });

            const persisted = collection.entries.length
              ? await sink.write(target, collection.entries)
              : 0;

            summary.usageEntries += collection.entries.length;
            summary.usagePersisted += persisted;
            providerSummary.usageEntries += collection.entries.length;

            if (collection.outcome === 'success') {
              summary.success += 1;
              providerSummary.success += 1;
            } else if (collection.outcome === 'partial') {
              summary.partial += 1;
              providerSummary.partial += 1;
              note(
                `${label}: ${collection.error ?? collection.unavailable.usage?.detail ?? 'partial'}`
              );
            } else {
              summary.failed += 1;
              providerSummary.failed += 1;
              note(`${label}: ${collection.error ?? 'collection failed'}`);
            }

            await record(target, {
              outcome: collection.outcome,
              providerStatus: collection.health.status,
              startedAt: collection.startedAt,
              finishedAt: collection.finishedAt,
              durationMs: collection.durationMs,
              latencyMs: collection.health.latencyMs,
              rateLimited: collection.health.rateLimited,
              attempts: collection.attempts,
              usageWindowStart: window.start,
              usageWindowEnd: window.end,
              usageEntryCount: collection.entries.length,
              usagePersistedCount: persisted,
              unavailable:
                Object.keys(collection.unavailable).length > 0 ? collection.unavailable : null,
              error: collection.error ?? null,
            });

            await saveCredentialCheck(
              target,
              collection.credentialOutcome,
              collection.error ?? null
            );

            logger(
              `${label}: ${collection.outcome} (${collection.health.status}, ${collection.entries.length} usage rows)`
            );
          } catch (error) {
            /**
             * Adapters are written to return failures rather than throw, so
             * reaching here means a genuine defect. It is contained to one
             * credential: a crash collecting from one provider must not stop
             * collection for every other.
             */
            const detail = scrubSecrets(
              error instanceof Error ? error.message : 'unexpected collector error'
            );

            summary.failed += 1;
            providerSummary.failed += 1;
            note(`${label}: ${detail}`);
            logger(`${label}: crashed — ${detail}`);

            await record(target, {
              outcome: 'failed',
              providerStatus: 'unknown',
              error: detail,
            }).catch(() => {
              // Recording the failure must not itself end the run.
            });
          }
        }
      }
    );

    return finish();
  } finally {
    await lock.release();
  }
}
