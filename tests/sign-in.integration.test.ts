import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { signIn, signOut } from '@/lib/auth/actions';
import { SESSION_COOKIE_NAME } from '@/lib/auth/cookies';
import { hashPassword } from '@/lib/auth/password';
import { validateSessionToken } from '@/lib/auth/session';
import { THROTTLE_LIMITS, throttleKeys } from '@/lib/auth/throttle';
import { closePool, getDb } from '@/lib/db/client';
import { loginAttempts, users } from '@/lib/db/schema';

/**
 * Signing in and out, through the real Server Actions.
 *
 *   npm run db:setup && npm run test:integration
 *
 * Next.js request APIs are replaced with an in-memory cookie jar and request
 * headers; everything behind them -- the users table, scrypt, sessions, the
 * throttle -- is real. The properties under test are the ones an attacker
 * probes: that every failure looks the same, that guessing is bounded, that
 * sign-out actually ends the session, and that `next` cannot redirect off-site.
 */

const jar = vi.hoisted(() => new Map<string, string>());
const request = vi.hoisted(() => ({ headers: {} as Record<string, string> }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string) => {
      if (value === '') jar.delete(name);
      else jar.set(name, value);
    },
    delete: (name: string) => jar.delete(name),
  }),
  headers: async () => new Headers(request.headers),
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;${url}` });
  },
  notFound: () => {
    throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_NOT_FOUND' });
  },
}));

const RUN = Math.random().toString(36).slice(2, 10);
const db = getDb();
const PASSWORD = 'correct-horse-battery-staple-9';
const INVALID = 'Invalid email or password.';

const active = `signin-${RUN}@example.com`;
const disabled = `disabled-${RUN}@example.com`;
const nobody = `nobody-${RUN}@example.com`;

/** Every throttle key a test touched, so cleanup is scoped to this run. */
const touched = new Set<string>();

let address = '';
let counter = 0;

function freshAddress(): string {
  counter += 1;
  return `198.51.${Math.floor(Math.random() * 250)}.${counter}`;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function track(email: string, from: string) {
  for (const key of throttleKeys(email, from)) touched.add(key.hash);
}

async function attempt(email: string, password: string, extra: Record<string, string> = {}) {
  track(email, address);
  return signIn({}, form({ email, password, ...extra })).catch((error: unknown) => error);
}

function redirectTarget(outcome: unknown): string | undefined {
  const digest = (outcome as { digest?: string } | null)?.digest;
  return digest?.startsWith('NEXT_REDIRECT;') ? digest.slice('NEXT_REDIRECT;'.length) : undefined;
}

beforeAll(async () => {
  const hash = await hashPassword(PASSWORD);

  await db.insert(users).values([
    { email: active, name: 'Active', passwordHash: hash },
    { email: disabled, name: 'Disabled', passwordHash: hash, status: 'disabled' },
  ]);
});

beforeEach(() => {
  jar.clear();
  // A fresh address per test, so one test's failures never throttle the next.
  address = freshAddress();
  request.headers = { 'x-forwarded-for': address };
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.email, [active, disabled]));
  if (touched.size > 0) {
    await db.delete(loginAttempts).where(inArray(loginAttempts.keyHash, [...touched]));
  }
  await closePool();
});

describe('signing in', () => {
  it('starts a real session and redirects', async () => {
    const outcome = await attempt(active, PASSWORD);

    expect(redirectTarget(outcome)).toBe('/');

    const token = jar.get(SESSION_COOKIE_NAME);
    expect(token).toBeTruthy();
    expect(await validateSessionToken(token ?? '')).not.toBeNull();
  });

  it('accepts the email in any case and with surrounding spaces', async () => {
    const outcome = await attempt(`  ${active.toUpperCase()}  `, PASSWORD);
    expect(redirectTarget(outcome)).toBe('/');
  });

  it('gives the same answer for a wrong password, an unknown email and a disabled account', async () => {
    const wrong = await attempt(active, 'not-the-password');
    const unknown = await attempt(nobody, PASSWORD);
    const locked = await attempt(disabled, PASSWORD);

    // Any difference here is a way to discover which accounts exist.
    expect(wrong).toEqual({ error: INVALID });
    expect(unknown).toEqual({ error: INVALID });
    expect(locked).toEqual({ error: INVALID });
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
  });

  it('refuses to redirect off-site through the next parameter', async () => {
    for (const next of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
      jar.clear();
      const outcome = await attempt(active, PASSWORD, { next });
      expect(redirectTarget(outcome)).toBe('/');
    }

    jar.clear();
    const inside = await attempt(active, PASSWORD, { next: '/organizations/abc/alerts' });
    expect(redirectTarget(inside)).toBe('/organizations/abc/alerts');
  });
});

describe('throttling password guessing', () => {
  it('refuses even the right password once the limit is reached', async () => {
    for (let index = 0; index < THROTTLE_LIMITS.pair; index += 1) {
      expect(await attempt(active, `guess-${index}`)).toEqual({ error: INVALID });
    }

    const outcome = await attempt(active, PASSWORD);

    expect(outcome).toMatchObject({ error: expect.stringMatching(/Too many sign-in attempts/) });
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
  });

  it('does not lock the account out for someone on a different network', async () => {
    for (let index = 0; index < THROTTLE_LIMITS.pair; index += 1) {
      await attempt(active, `guess-${index}`);
    }

    address = freshAddress();
    request.headers = { 'x-forwarded-for': address };

    const outcome = await attempt(active, PASSWORD);
    expect(redirectTarget(outcome)).toBe('/');
  });

  it('throttles an unknown email exactly as it would a real one', async () => {
    for (let index = 0; index < THROTTLE_LIMITS.pair; index += 1) {
      await attempt(nobody, `guess-${index}`);
    }

    // The same message a real account gets, so throttling cannot enumerate either.
    const outcome = await attempt(nobody, PASSWORD);
    expect(outcome).toMatchObject({ error: expect.stringMatching(/Too many sign-in attempts/) });
  });

  it('forgives earlier typos once the user gets in', async () => {
    await attempt(active, 'typo-1');
    await attempt(active, 'typo-2');
    expect(redirectTarget(await attempt(active, PASSWORD))).toBe('/');

    // The pair counter was cleared, so a full budget is available again.
    for (let index = 0; index < THROTTLE_LIMITS.pair - 1; index += 1) {
      expect(await attempt(active, `later-${index}`)).toEqual({ error: INVALID });
    }
    expect(redirectTarget(await attempt(active, PASSWORD))).toBe('/');
  });
});

describe('signing out', () => {
  it('ends the session on the server, not just in the browser', async () => {
    await attempt(active, PASSWORD);
    const token = jar.get(SESSION_COOKIE_NAME) ?? '';
    expect(await validateSessionToken(token)).not.toBeNull();

    const outcome = await signOut().catch((error: unknown) => error);

    expect(redirectTarget(outcome)).toBe('/login');
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
    // Someone who captured the cookie before sign-out cannot keep using it.
    expect(await validateSessionToken(token)).toBeNull();
  });

  it('succeeds with no session at all', async () => {
    const outcome = await signOut().catch((error: unknown) => error);
    expect(redirectTarget(outcome)).toBe('/login');
  });
});

describe('fixtures', () => {
  it('stores the disabled account as disabled', async () => {
    const [row] = await db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.email, disabled));
    expect(row.status).toBe('disabled');
  });
});
