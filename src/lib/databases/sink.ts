import type { DatabaseMetricsSink } from './types';

/**
 * A sink that counts a snapshot's metrics and stores none of them.
 *
 * Used by `npm run collect:db -- --dry-run` to exercise a target end to end --
 * connection, privileges, every query -- without writing anything, which is how
 * a new monitoring role gets verified against production before it is trusted.
 *
 * Its name appears in the run summary, so a dry run cannot be mistaken for one
 * that stored metrics.
 */
export const discardingDatabaseSink: DatabaseMetricsSink = {
  name: 'discard (dry run)',
  async write() {
    return { stored: 0, notes: ['Dry run: metrics were collected but not stored.'] };
  },
};
