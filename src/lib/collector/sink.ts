import type { UsageSink } from './types';

/**
 * A sink that counts normalized usage and stores none of it.
 *
 * Not a leftover: `npm run collect --dry-run` uses it to exercise every
 * provider, adapter and credential end to end -- including how many intervals
 * each one returns -- without touching the time series. That makes it safe to
 * check a new credential, or a provider's behaviour after an API change,
 * against a production database.
 *
 * It is deliberately not silent about storing nothing: `name` appears in the
 * run summary, so a dry run cannot be mistaken for a real one.
 */
export const discardingUsageSink: UsageSink = {
  name: 'discard (dry run)',
  async write(_target, entries) {
    return {
      stored: 0,
      skipped: entries.length,
      notes: entries.length > 0 ? ['Dry run: usage was collected but not stored.'] : [],
    };
  },
};
