import { createHash, randomBytes } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';

import { getDb } from '@/lib/db/client';
import { sessions, users, type SafeUser } from '@/lib/db/schema';

/**
 * Server-side session storage.
 *
 * SECURITY: the database stores only a SHA-256 hash of the session token, so a
 * dump of the `sessions` table cannot be replayed to impersonate anyone. The
 * token itself lives only in the client's cookie.
 *
 * A plain hash is correct here, unlike for passwords: the token is 256 bits of
 * CSPRNG output, so there is nothing to brute-force and no need for a slow KDF
 * on the hot path of every request.
 *
 * This module deliberately imports nothing from Next.js, so it can be tested
 * without a request context. Cookie handling lives in `cookies.ts`.
 */

/** Absolute lifetime. A session is dead past this point no matter how active. */
export const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

/** A session unused for this long is dead, even if its absolute expiry is later. */
export const SESSION_IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `lastUsedAt` is only rewritten once per interval rather than on every
 * request, so a busy dashboard does not issue a write per page view.
 */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

const TOKEN_BYTES = 32;

/** Generates an opaque session token. Returned once and never stored in clear. */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** The value actually persisted for a token. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface AuthenticatedUser {
  user: SafeUser;
  sessionId: string;
}

/**
 * Issues a new session for a user.
 *
 * Returns the plaintext token, which is the only moment it exists server-side.
 * Callers must place it in a cookie and then discard it.
 */
export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  await getDb()
    .insert(sessions)
    .values({
      tokenHash: hashSessionToken(token),
      userId,
      expiresAt,
    });

  return { token, expiresAt };
}

/**
 * Resolves a session token to its user, or `null` if the token is unusable for
 * any reason: unknown, expired, idle too long, or belonging to a disabled user.
 *
 * A disabled user is rejected here rather than only at sign-in, so revoking
 * access takes effect on the next request instead of at token expiry.
 */
export async function validateSessionToken(token: string): Promise<AuthenticatedUser | null> {
  if (!token) return null;

  const db = getDb();
  const now = new Date();

  const [row] = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      lastUsedAt: sessions.lastUsedAt,
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
        status: users.status,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      },
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, hashSessionToken(token)))
    .limit(1);

  if (!row) return null;

  const expired = row.expiresAt.getTime() <= now.getTime();
  const idle = now.getTime() - row.lastUsedAt.getTime() > SESSION_IDLE_TIMEOUT_MS;

  if (expired || idle) {
    // Clean up as we go, so abandoned sessions do not require a sweeper to
    // stop being a liability.
    await db.delete(sessions).where(eq(sessions.id, row.sessionId));
    return null;
  }

  if (row.user.status !== 'active') return null;

  if (now.getTime() - row.lastUsedAt.getTime() > SESSION_TOUCH_INTERVAL_MS) {
    await db.update(sessions).set({ lastUsedAt: now }).where(eq(sessions.id, row.sessionId));
  }

  return { user: row.user, sessionId: row.sessionId };
}

/** Revokes one session. Used on sign-out. */
export async function revokeSession(sessionId: string): Promise<void> {
  await getDb().delete(sessions).where(eq(sessions.id, sessionId));
}

/** Revokes a session by its token, when only the cookie value is at hand. */
export async function revokeSessionByToken(token: string): Promise<void> {
  if (!token) return;
  await getDb()
    .delete(sessions)
    .where(eq(sessions.tokenHash, hashSessionToken(token)));
}

/**
 * Revokes every session for a user.
 *
 * Called when a password changes or an account is disabled -- otherwise an
 * attacker with a stolen cookie keeps access after the credential is fixed.
 */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  await getDb().delete(sessions).where(eq(sessions.userId, userId));
}

/**
 * Deletes sessions that are past their absolute expiry.
 *
 * `validateSessionToken` already removes them on access; this exists for rows
 * whose owner never returns.
 */
export async function deleteExpiredSessions(): Promise<number> {
  const deleted = await getDb()
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ id: sessions.id });

  return deleted.length;
}
