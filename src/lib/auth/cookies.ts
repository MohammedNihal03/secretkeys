import { cookies } from 'next/headers';

import { getEnv } from '@/lib/env';
import { SESSION_DURATION_MS } from './session';

/**
 * Session cookie handling.
 *
 * Isolated from `session.ts` because `next/headers` is only available inside a
 * request context. Reading works anywhere on the server; *setting* a cookie is
 * only permitted in a Server Action or Route Handler, not a Server Component.
 */

export const SESSION_COOKIE_NAME = 'observability_session';

/**
 * `httpOnly` keeps the token away from JavaScript, so an XSS bug cannot read
 * it. `sameSite: 'lax'` stops the cookie riding along on cross-site POSTs,
 * which is the main CSRF vector, while still surviving a normal top-level
 * navigation back into the app.
 *
 * `secure` is conditional only so that development over plain http works;
 * every real deployment must be HTTPS.
 */
function cookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: getEnv().NODE_ENV === 'production',
    path: '/',
    expires,
  };
}

/** Reads the session token from the request, if present. */
export async function readSessionCookie(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE_NAME)?.value;
}

/** Sets the session cookie. Only valid inside a Server Action or Route Handler. */
export async function setSessionCookie(token: string, expiresAt?: Date): Promise<void> {
  const store = await cookies();
  store.set(
    SESSION_COOKIE_NAME,
    token,
    cookieOptions(expiresAt ?? new Date(Date.now() + SESSION_DURATION_MS))
  );
}

/**
 * Clears the session cookie.
 *
 * Overwritten with an empty value and a past expiry rather than only deleted,
 * so a client that ignores `delete` still ends up with nothing usable.
 */
export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, '', cookieOptions(new Date(0)));
  store.delete(SESSION_COOKIE_NAME);
}
