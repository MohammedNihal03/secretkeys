import { describe, expect, it } from 'vitest';

import {
  checkThrottle,
  clearOnSuccess,
  clientAddress,
  recordFailure,
  THROTTLE_LIMITS,
  THROTTLE_WINDOW_MS,
  throttledMessage,
  throttleKeys,
  type ThrottleStore,
} from '@/lib/auth/throttle';

/**
 * Sign-in throttling, against an in-memory store.
 *
 * The policy is the part worth pinning down: which keys an attempt counts
 * against, when each rule trips, and that nothing about it depends on whether
 * the account exists.
 */

function memoryStore(clock: { now: Date }) {
  const rows: { hash: string; at: Date }[] = [];

  const store: ThrottleStore = {
    async countSince(hashes, since) {
      const result = new Map<string, { count: number; oldest: Date }>();

      for (const row of rows) {
        if (!hashes.includes(row.hash) || row.at < since) continue;

        const entry = result.get(row.hash);
        if (!entry) result.set(row.hash, { count: 1, oldest: row.at });
        else {
          entry.count += 1;
          if (row.at < entry.oldest) entry.oldest = row.at;
        }
      }

      return result;
    },
    async record(hashes) {
      for (const hash of hashes) rows.push({ hash, at: clock.now });
    },
    async clear(hashes) {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (hashes.includes(rows[index].hash)) rows.splice(index, 1);
      }
    },
    async prune(olderThan) {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index].at < olderThan) rows.splice(index, 1);
      }
    },
  };

  return { store, rows };
}

async function fail(
  times: number,
  email: string,
  address: string | null,
  store: ThrottleStore,
  now: Date
) {
  for (let attempt = 0; attempt < times; attempt += 1) {
    await recordFailure(throttleKeys(email, address), store, now);
  }
}

describe('the keys an attempt counts against', () => {
  it('counts one attempt against the pair, the email and the address', () => {
    const keys = throttleKeys('ada@example.com', '203.0.113.7');

    expect(keys.map((key) => key.scope)).toEqual(['pair', 'email', 'address']);
    expect(new Set(keys.map((key) => key.hash)).size).toBe(3);
  });

  it('stores nothing that reads back as an email or an address', () => {
    for (const key of throttleKeys('ada@example.com', '203.0.113.7')) {
      expect(key.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(key.hash).not.toContain('ada');
    }
  });

  it('drops the address rule when there is no address', () => {
    /**
     * Otherwise every request without a forwarding header would share one
     * bucket, and thirty failures from anyone would lock out everyone.
     */
    expect(throttleKeys('ada@example.com', null).map((key) => key.scope)).toEqual([
      'pair',
      'email',
    ]);
  });
});

describe('when throttling trips', () => {
  const start = new Date('2026-09-13T12:00:00Z');

  it('allows attempts up to the pair limit, then refuses', async () => {
    const clock = { now: start };
    const { store } = memoryStore(clock);
    const keys = throttleKeys('ada@example.com', '203.0.113.7');

    await fail(THROTTLE_LIMITS.pair - 1, 'ada@example.com', '203.0.113.7', store, start);
    expect(await checkThrottle(keys, store, start)).toEqual({ allowed: true });

    await fail(1, 'ada@example.com', '203.0.113.7', store, start);
    const decision = await checkThrottle(keys, store, start);

    expect(decision.allowed).toBe(false);
    expect(!decision.allowed && decision.retryAfterMs).toBe(THROTTLE_WINDOW_MS);
  });

  it('lets the oldest failure age out of the window', async () => {
    const clock = { now: start };
    const { store } = memoryStore(clock);
    const keys = throttleKeys('ada@example.com', '203.0.113.7');

    await fail(THROTTLE_LIMITS.pair, 'ada@example.com', '203.0.113.7', store, start);

    const later = new Date(start.getTime() + THROTTLE_WINDOW_MS + 1);
    expect(await checkThrottle(keys, store, later)).toEqual({ allowed: true });
  });

  it('still limits one account when the attacker rotates addresses', async () => {
    const clock = { now: start };
    const { store } = memoryStore(clock);

    // Each address stays under its own pair limit...
    for (let index = 0; index < THROTTLE_LIMITS.email; index += 1) {
      await fail(1, 'admin@example.com', `198.51.100.${index}`, store, start);
    }

    // ...but the account itself has had enough, from a brand-new address too.
    const decision = await checkThrottle(
      throttleKeys('admin@example.com', '192.0.2.200'),
      store,
      start
    );
    expect(decision.allowed).toBe(false);
  });

  it('limits one address spraying many accounts', async () => {
    const clock = { now: start };
    const { store } = memoryStore(clock);

    for (let index = 0; index < THROTTLE_LIMITS.address; index += 1) {
      await fail(1, `user${index}@example.com`, '203.0.113.9', store, start);
    }

    const decision = await checkThrottle(
      throttleKeys('someone-new@example.com', '203.0.113.9'),
      store,
      start
    );
    expect(decision.allowed).toBe(false);
  });

  it('behaves identically for an account that does not exist', async () => {
    // The throttle never consults the users table, so it cannot leak it.
    const clock = { now: start };
    const { store } = memoryStore(clock);

    await fail(THROTTLE_LIMITS.pair, 'nobody@example.com', '203.0.113.7', store, start);

    const decision = await checkThrottle(
      throttleKeys('nobody@example.com', '203.0.113.7'),
      store,
      start
    );
    expect(decision.allowed).toBe(false);
  });

  it('forgives the pair on success, but not the account or the address', async () => {
    const clock = { now: start };
    const { store, rows } = memoryStore(clock);
    const keys = throttleKeys('ada@example.com', '203.0.113.7');

    await fail(2, 'ada@example.com', '203.0.113.7', store, start);
    await clearOnSuccess(keys, store);

    const remaining = new Set(rows.map((row) => row.hash));
    expect(remaining.has(keys[0].hash)).toBe(false);
    // Clearing these would let one real account reset the budget for others.
    expect(remaining.has(keys[1].hash)).toBe(true);
    expect(remaining.has(keys[2].hash)).toBe(true);
  });

  it('prunes attempts older than a day as it records new ones', async () => {
    const clock = { now: start };
    const { store, rows } = memoryStore(clock);

    await fail(1, 'ada@example.com', null, store, start);

    const nextDay = new Date(start.getTime() + 25 * 60 * 60 * 1000);
    clock.now = nextDay;
    await fail(1, 'ada@example.com', null, store, nextDay);

    expect(rows.every((row) => row.at.getTime() === nextDay.getTime())).toBe(true);
  });
});

describe('the client address', () => {
  it('takes the original client from a forwarding chain', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.2, 10.0.0.1' });
    expect(clientAddress(headers)).toBe('203.0.113.7');
  });

  it('falls back to x-real-ip, then to nothing', () => {
    expect(clientAddress(new Headers({ 'x-real-ip': '198.51.100.4' }))).toBe('198.51.100.4');
    expect(clientAddress(new Headers())).toBeNull();
  });

  it('bounds an absurd header rather than hashing megabytes of it', () => {
    const headers = new Headers({ 'x-forwarded-for': 'a'.repeat(10_000) });
    expect(clientAddress(headers)?.length).toBe(64);
  });
});

describe('the message', () => {
  it('rounds up to whole minutes and never says zero', () => {
    expect(throttledMessage(THROTTLE_WINDOW_MS)).toBe(
      'Too many sign-in attempts. Try again in 15 minutes.'
    );
    expect(throttledMessage(1)).toBe('Too many sign-in attempts. Try again in 1 minute.');
  });
});
