import { createHash } from 'node:crypto';
import { and, count, gte, inArray, lt, min } from 'drizzle-orm';

import { getDb } from '@/lib/db/client';
import { loginAttempts } from '@/lib/db/schema';

/**
 * Throttling password guessing.
 *
 * scrypt makes each guess expensive for the attacker, but nothing stopped them
 * making unlimited guesses. Three rules now bound it, each closing a gap the
 * others leave:
 *
 * - **email + address, 5 per 15 minutes** -- the tight rule. One person, one
 *   network, guessing one account. Cleared on a successful sign-in, so a user
 *   who mistyped twice is not penalised next time.
 * - **email, 20 per 15 minutes** -- an attacker rotating addresses (a botnet,
 *   or a forged forwarding header) still hits a ceiling per account.
 * - **address, 30 per 15 minutes** -- one source spraying many accounts.
 *
 * The cost of the email rule is known and accepted: someone who knows an
 * admin's address can lock that account out for fifteen minutes with twenty
 * bad guesses. Every account-based throttle has this property; the alternative
 * is unlimited guessing.
 *
 * Throttling applies identically to emails that do not exist, and the message
 * does not change with it, so it cannot be used to discover accounts.
 */

export const THROTTLE_WINDOW_MS = 15 * 60 * 1000;

/** Rows older than this are pruned; comfortably longer than any window. */
const RETENTION_MS = 24 * 60 * 60 * 1000;

export type ThrottleScope = 'pair' | 'email' | 'address';

export const THROTTLE_LIMITS: Record<ThrottleScope, number> = {
  pair: 5,
  email: 20,
  address: 30,
};

export interface ThrottleKey {
  scope: ThrottleScope;
  hash: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The keys one attempt counts against.
 *
 * With no client address there is no address rule -- otherwise every request
 * without a forwarding header would share one bucket, and thirty failures from
 * anyone would lock everyone out.
 */
export function throttleKeys(email: string, address: string | null): ThrottleKey[] {
  const keys: ThrottleKey[] = [
    { scope: 'pair', hash: hash(`pair:${email}|${address ?? 'unknown'}`) },
    { scope: 'email', hash: hash(`email:${email}`) },
  ];

  if (address) keys.push({ scope: 'address', hash: hash(`address:${address}`) });

  return keys;
}

/**
 * The client address, from the reverse proxy's forwarding headers.
 *
 * SECURITY: these headers are only trustworthy behind a proxy that overwrites
 * them. Exposed directly to the internet, a client can send any value it likes,
 * which defeats the address rule -- but not the email rule, which is why that
 * one exists. The README tells operators to deploy behind a proxy.
 */
export function clientAddress(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');

  if (forwarded) {
    // The first entry is the original client; the rest are proxies it passed through.
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first.slice(0, 64);
  }

  const real = headers.get('x-real-ip')?.trim();
  return real ? real.slice(0, 64) : null;
}

export interface AttemptCount {
  count: number;
  oldest: Date;
}

/** Where attempts are counted. The database in production; a map in tests. */
export interface ThrottleStore {
  countSince(hashes: string[], since: Date): Promise<Map<string, AttemptCount>>;
  record(hashes: string[]): Promise<void>;
  clear(hashes: string[]): Promise<void>;
  prune(olderThan: Date): Promise<void>;
}

export type ThrottleDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

/**
 * Whether this attempt may proceed.
 *
 * Checked *before* the password is verified. A throttled request must not cost
 * a scrypt derivation either: that is itself something an attacker could use
 * to exhaust the server.
 */
export async function checkThrottle(
  keys: readonly ThrottleKey[],
  store: ThrottleStore,
  now: Date = new Date()
): Promise<ThrottleDecision> {
  const since = new Date(now.getTime() - THROTTLE_WINDOW_MS);
  const counts = await store.countSince(
    keys.map((key) => key.hash),
    since
  );

  let retryAfterMs = 0;

  for (const key of keys) {
    const entry = counts.get(key.hash);
    if (!entry || entry.count < THROTTLE_LIMITS[key.scope]) continue;

    // Allowed again once the oldest counted failure falls out of the window.
    const until = entry.oldest.getTime() + THROTTLE_WINDOW_MS - now.getTime();
    retryAfterMs = Math.max(retryAfterMs, until);
  }

  return retryAfterMs > 0 ? { allowed: false, retryAfterMs } : { allowed: true };
}

/** Records a failed attempt against every key it counts toward. */
export async function recordFailure(
  keys: readonly ThrottleKey[],
  store: ThrottleStore,
  now: Date = new Date()
): Promise<void> {
  await store.record(keys.map((key) => key.hash));
  await store.prune(new Date(now.getTime() - RETENTION_MS));
}

/**
 * Forgives the tight rule after a successful sign-in.
 *
 * Only the pair: clearing the email or address counters on success would let
 * an attacker who also controls one real account reset the budget for every
 * account they are guessing.
 */
export async function clearOnSuccess(
  keys: readonly ThrottleKey[],
  store: ThrottleStore
): Promise<void> {
  await store.clear(keys.filter((key) => key.scope === 'pair').map((key) => key.hash));
}

/** The user-facing message, identical whether or not the account exists. */
export function throttledMessage(retryAfterMs: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  return `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

export const databaseThrottleStore: ThrottleStore = {
  async countSince(hashes, since) {
    if (hashes.length === 0) return new Map();

    const rows = await getDb()
      .select({
        keyHash: loginAttempts.keyHash,
        count: count(),
        oldest: min(loginAttempts.createdAt),
      })
      .from(loginAttempts)
      .where(and(inArray(loginAttempts.keyHash, hashes), gte(loginAttempts.createdAt, since)))
      .groupBy(loginAttempts.keyHash);

    return new Map(
      rows
        .filter((row) => row.oldest !== null)
        .map((row) => [row.keyHash, { count: Number(row.count), oldest: row.oldest as Date }])
    );
  },

  async record(hashes) {
    if (hashes.length === 0) return;
    await getDb()
      .insert(loginAttempts)
      .values(hashes.map((keyHash) => ({ keyHash })));
  },

  async clear(hashes) {
    if (hashes.length === 0) return;
    await getDb().delete(loginAttempts).where(inArray(loginAttempts.keyHash, hashes));
  },

  async prune(olderThan) {
    await getDb().delete(loginAttempts).where(lt(loginAttempts.createdAt, olderThan));
  },
};
