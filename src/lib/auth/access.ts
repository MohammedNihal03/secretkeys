import { cache } from 'react';
import { and, eq } from 'drizzle-orm';

import { getDb } from '@/lib/db/client';
import { organizationMembers, organizations, type OrgRole } from '@/lib/db/schema';
import { readSessionCookie } from './cookies';
import { hasPermission, type Permission } from './permissions';
import { validateSessionToken, type AuthenticatedUser } from './session';

/**
 * Authentication and authorization lookups.
 *
 * The distinction this module enforces:
 *
 *   - a **session** proves who you are
 *   - a **membership row** is what grants access to an organization's data
 *   - a **role** decides what you may do inside it
 *
 * Holding a valid session conveys no authority over any organization. Every
 * organization-scoped read must go through `getOrgAccess` (or a caller that
 * did), so the membership check cannot be forgotten.
 *
 * The `resolve*` functions take a user id and touch only the database. The
 * request-scoped wrappers below add "who is signed in" on top. Keeping them
 * separate means the isolation rule can be tested directly against a real
 * database, with no cookie or React request context involved.
 */

export interface OrgAccess {
  user: AuthenticatedUser['user'];
  sessionId: string;
  organizationId: string;
  organizationName: string;
  role: OrgRole;
}

export interface Membership {
  organizationId: string;
  organizationName: string;
  role: OrgRole;
}

/**
 * A user's membership of one organization, or `null` if they hold none.
 *
 * Returning `null` for "not a member" and for "no such organization" is
 * deliberate: callers must not be able to tell the difference. See
 * `requireOrgAccess` in `guards.ts`.
 */
export async function resolveMembership(
  userId: string,
  organizationId: string
): Promise<Membership | null> {
  const [row] = await getDb()
    .select({
      organizationId: organizations.id,
      organizationName: organizations.name,
      role: organizationMembers.role,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizationMembers.organizationId, organizations.id))
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.organizationId, organizationId)
      )
    )
    .limit(1);

  return row ?? null;
}

/** Every organization a user belongs to, by name. */
export async function resolveMemberships(userId: string): Promise<Membership[]> {
  return getDb()
    .select({
      organizationId: organizations.id,
      organizationName: organizations.name,
      role: organizationMembers.role,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizationMembers.organizationId, organizations.id))
    .where(eq(organizationMembers.userId, userId))
    .orderBy(organizations.name);
}

/**
 * The signed-in user, or `null`.
 *
 * Wrapped in React's `cache` so several server components in one render share
 * a single session lookup instead of each hitting the database.
 */
export const getCurrentUser = cache(async (): Promise<AuthenticatedUser | null> => {
  const token = await readSessionCookie();
  if (!token) return null;

  return validateSessionToken(token);
});

/** The current user's access to one organization, or `null`. */
export const getOrgAccess = cache(async (organizationId: string): Promise<OrgAccess | null> => {
  const authenticated = await getCurrentUser();
  if (!authenticated) return null;

  const membership = await resolveMembership(authenticated.user.id, organizationId);
  if (!membership) return null;

  return {
    user: authenticated.user,
    sessionId: authenticated.sessionId,
    ...membership,
  };
});

/** Every organization the current user belongs to. Drives org switching. */
export const listMemberships = cache(async (): Promise<Membership[]> => {
  const authenticated = await getCurrentUser();
  if (!authenticated) return [];

  return resolveMemberships(authenticated.user.id);
});

/** Whether the current user may perform `permission` in `organizationId`. */
export async function can(organizationId: string, permission: Permission): Promise<boolean> {
  const access = await getOrgAccess(organizationId);
  return access ? hasPermission(access.role, permission) : false;
}
