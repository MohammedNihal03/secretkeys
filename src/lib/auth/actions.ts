'use server';

import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { getDb } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { clearSessionCookie, readSessionCookie, setSessionCookie } from './cookies';
import { safeRedirectPath } from './guards';
import { getDummyDigest, normalizeEmail, verifyPassword } from './password';
import { createSession, revokeSessionByToken } from './session';

/**
 * Sign-in and sign-out.
 *
 * Implemented as Server Actions rather than route handlers because Next.js
 * verifies the request Origin against the Host for actions, which gives CSRF
 * protection without a hand-rolled token.
 */

export interface SignInState {
  error?: string;
}

/**
 * Deliberately identical for an unknown email, a wrong password and a disabled
 * account. Distinguishing them would let anyone enumerate valid accounts.
 */
const INVALID_CREDENTIALS = 'Invalid email or password.';

const signInSchema = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
  next: z.string().optional(),
});

export async function signIn(_previous: SignInState, formData: FormData): Promise<SignInState> {
  const parsed = signInSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    next: formData.get('next') ?? undefined,
  });

  if (!parsed.success) {
    return { error: INVALID_CREDENTIALS };
  }

  const { email, password, next } = parsed.data;

  const [user] = await getDb()
    .select({
      id: users.id,
      passwordHash: users.passwordHash,
      status: users.status,
    })
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1);

  /**
   * Verify even when there is no such user, against a throwaway digest.
   *
   * Returning early here would make "no such account" measurably faster than
   * "wrong password", which is enough to enumerate valid emails. Both paths now
   * perform one scrypt derivation.
   */
  const digest = user?.passwordHash ?? (await getDummyDigest());
  const passwordMatches = await verifyPassword(password, digest);

  if (!user || !passwordMatches || user.status !== 'active') {
    return { error: INVALID_CREDENTIALS };
  }

  const { token, expiresAt } = await createSession(user.id);
  await setSessionCookie(token, expiresAt);

  // A rejected `next` falls back to the root rather than failing the sign-in.
  redirect(safeRedirectPath(next) ?? '/');
}

export async function signOut(): Promise<never> {
  const token = await readSessionCookie();

  // Revoke server-side first: clearing only the cookie would leave a usable
  // session behind for anyone who captured the token.
  await revokeSessionByToken(token ?? '');
  await clearSessionCookie();

  redirect('/login');
}
