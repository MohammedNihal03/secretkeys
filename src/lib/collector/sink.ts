import type { UsageSink } from './types';

/**
 * The default sink: normalized usage is counted, then dropped.
 *
 * Phase 5 builds the collector; Phase 6 defines the usage table and supplies a
 * sink that stores these rows. Until then the collector still runs, still
 * reports what each provider returned, and records how many rows it produced --
 * so the count and the storage can be verified independently.
 *
 * It is deliberately not silent about being a placeholder: `name` appears in
 * the run summary, so a collection that stores nothing cannot be mistaken for
 * one that stored everything.
 */
export const discardingUsageSink: UsageSink = {
  name: 'discard (usage storage arrives in Phase 6)',
  async write() {
    return 0;
  },
};
