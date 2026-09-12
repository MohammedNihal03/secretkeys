import type {
  CollectionTarget,
  UsageSink,
  UsageWriteContext,
  UsageWriteResult,
} from '@/lib/collector/types';
import type { NormalizedUsage } from '@/lib/providers/types';
import { attributeEntries, type KeyDirectory } from './attribution';
import {
  hasReportedMetric,
  intervalKey,
  mergeIntervals,
  toUsageRow,
  type UsageRowInput,
} from './normalize';
import { loadKeyDirectory, upsertUsageRows } from './repository';

/**
 * The sink that stores usage.
 *
 * Three things happen between a provider's answer and a stored row, and each
 * exists to stop a specific way a usage table goes wrong:
 *
 * 1. **Attribution.** An organization-wide usage endpoint returns every key's
 *    consumption; a row we cannot map to a registered credential is dropped
 *    with a reason rather than billed to whichever key fetched it.
 * 2. **Merging.** Providers split an interval further than we store it, and a
 *    single upsert cannot touch the same row twice.
 * 3. **An empty row is not a row.** An interval in which the provider reported
 *    no metric at all is not stored -- "do not create data simply because the
 *    UI refreshes" applies just as much to a collection that found nothing.
 */

export interface DatabaseUsageSinkDeps {
  loadDirectory?: (organizationId: string, providerId: string) => Promise<KeyDirectory>;
  save?: (rows: readonly UsageRowInput[]) => Promise<number>;
}

export function createDatabaseUsageSink(deps: DatabaseUsageSinkDeps = {}): UsageSink {
  const loadDirectory = deps.loadDirectory ?? loadKeyDirectory;
  const save = deps.save ?? upsertUsageRows;

  return {
    name: 'ai_usage',

    async write(
      target: CollectionTarget,
      entries: readonly NormalizedUsage[],
      context: UsageWriteContext
    ): Promise<UsageWriteResult> {
      if (entries.length === 0) return { stored: 0, skipped: 0, notes: [] };

      const directory = await loadDirectory(target.organizationId, target.providerId);
      const attribution = attributeEntries(target, entries, directory);

      const rows = attribution.attributed.map(({ entry, attribution: where }) =>
        toUsageRow(entry, target, where, context)
      );

      const merged = mergeIntervals(rows);
      const storable = merged.filter(hasReportedMetric);

      /**
       * Skips are counted in entries rather than merged intervals, so a skip
       * always answers "how much of what the provider sent is missing from the
       * table". Merging is not a skip: those entries are stored, combined.
       */
      const emptyIntervals = new Set(
        merged.filter((row) => !hasReportedMetric(row)).map(intervalKey)
      );
      const emptyEntries = rows.filter((row) => emptyIntervals.has(intervalKey(row))).length;

      const notes = [...attribution.notes];

      if (emptyIntervals.size > 0) {
        notes.push(
          `${target.providerName} · ${target.keyName}: ${emptyIntervals.size} ${
            emptyIntervals.size === 1 ? 'interval' : 'intervals'
          } carried no metric the provider could report, so nothing was stored for them.`
        );
      }

      return {
        stored: await save(storable),
        skipped: attribution.skipped + emptyEntries,
        notes,
      };
    },
  };
}

/** The default sink: writes to `ai_usage`. */
export const databaseUsageSink = createDatabaseUsageSink();
