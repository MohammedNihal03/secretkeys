import { getPool } from '@/lib/db/client';

/**
 * A single-collection lock, held in Postgres.
 *
 * Two collections running at once would call every provider twice, double any
 * usage the Phase 6 sink stores, and burn rate limit on duplicate work. A
 * Postgres advisory lock prevents that across processes and machines -- a flag
 * in memory would only prevent it within one process, which is exactly the case
 * that does not need protecting.
 *
 * The lock is session-scoped, so one pooled client is held for the whole run
 * and released at the end. If the process dies the session ends and Postgres
 * drops the lock on its own; nothing has to be cleaned up by hand.
 */

/**
 * Arbitrary but fixed. Advisory lock keys share one namespace per database, so
 * this constant is what makes every deployment of this application agree on
 * which lock means "a collection is running".
 */
export const COLLECTOR_LOCK_KEY = 4_726_301;

export interface CollectorLock {
  release(): Promise<void>;
}

/** Returns the lock, or `null` when another collection already holds it. */
export async function acquireCollectorLock(): Promise<CollectorLock | null> {
  const client = await getPool().connect();

  try {
    const result = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock($1) as locked',
      [COLLECTOR_LOCK_KEY]
    );

    if (!result.rows[0]?.locked) {
      client.release();
      return null;
    }

    return {
      async release() {
        try {
          await client.query('select pg_advisory_unlock($1)', [COLLECTOR_LOCK_KEY]);
        } finally {
          // Returned to the pool even if the unlock fails, so a failure here
          // cannot leak a connection on top of a stuck lock.
          client.release();
        }
      },
    };
  } catch (error) {
    client.release();
    throw error;
  }
}
