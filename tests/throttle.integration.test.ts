import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import {
  checkThrottle,
  clearOnSuccess,
  databaseThrottleStore,
  recordFailure,
  THROTTLE_LIMITS,
  throttleKeys,
} from '@/lib/auth/throttle';
import { closePool, getDb } from '@/lib/db/client';
import { loginAttempts } from '@/lib/db/schema';

/**
 * The throttle's database store.
 *
 * The in-memory tests pin the policy; this proves the store behind it counts,
 * clears and prunes the way the policy assumes -- across processes, which is
 * the whole reason it lives in Postgres.
 */

const RUN = Math.random().toString(36).slice(2, 10);
const email = `throttle-${RUN}@example.com`;
const address = `203.0.113.${Math.floor(Math.random() * 200)}`;
const keys = throttleKeys(email, address);

afterAll(async () => {
  // Scoped to this run's keys: never an unscoped delete in a test.
  await getDb()
    .delete(loginAttempts)
    .where(
      inArray(
        loginAttempts.keyHash,
        keys.map((key) => key.hash)
      )
    );
  await closePool();
});

describe('the database throttle store', () => {
  it('counts failures per key and trips at the pair limit', async () => {
    for (let attempt = 0; attempt < THROTTLE_LIMITS.pair; attempt += 1) {
      await recordFailure(keys, databaseThrottleStore);
    }

    const decision = await checkThrottle(keys, databaseThrottleStore);

    expect(decision.allowed).toBe(false);
    expect(!decision.allowed && decision.retryAfterMs).toBeGreaterThan(0);
  });

  it('writes only hashes', async () => {
    const rows = await getDb()
      .select({ keyHash: loginAttempts.keyHash })
      .from(loginAttempts)
      .where(
        inArray(
          loginAttempts.keyHash,
          keys.map((key) => key.hash)
        )
      );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.keyHash).not.toContain(RUN);
    }
  });

  it('clears the pair after a success and lets the next attempt through', async () => {
    await clearOnSuccess(keys, databaseThrottleStore);

    expect(await checkThrottle(keys, databaseThrottleStore)).toEqual({ allowed: true });
  });

  it('reports nothing for keys it has never seen', async () => {
    const counts = await databaseThrottleStore.countSince(
      throttleKeys(`never-${RUN}@example.com`, null).map((key) => key.hash),
      new Date(0)
    );

    expect(counts.size).toBe(0);
  });
});
