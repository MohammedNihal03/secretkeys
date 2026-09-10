import { notFound, redirect } from 'next/navigation';

import { getCurrentUser, getOrgAccess, type OrgAccess } from './access';
import { hasPermission, type Permission } from './permissions';
import type { AuthenticatedUser } from './session';

/**
 * Guards for pages and Server Actions.
 *
 * These are the real security boundary. `proxy.ts` performs a cheap
 * cookie-presence check to avoid rendering a page that will only redirect, but
 * it never validates the session -- it runs separately from render code and
 * cannot reach the database. Anything that reads organization data must call a
 * guard here.
 */

export const LOGIN_PATH = '/login';

/**
 * Requires a signed-in user, or redirects to sign-in.
 *
 * `redirectTo` is validated as a same-site absolute path, so a crafted `next`
 * parameter cannot turn the sign-in page into an open redirect.
 */
export async function requireUser(redirectTo?: string): Promise<AuthenticatedUser> {
  const authenticated = await getCurrentUser();
  if (authenticated) return authenticated;

  const target = safeRedirectPath(redirectTo);
  redirect(target ? `${LOGIN_PATH}?next=${encodeURIComponent(target)}` : LOGIN_PATH);
}

/**
 * Requires membership of an organization.
 *
 * Responds with 404 rather than 403 when the user is not a member. A 403 would
 * confirm that the organization exists, letting anyone with an account probe
 * for other tenants by id. To a non-member, the organization simply is not
 * there.
 */
export async function requireOrgAccess(organizationId: string): Promise<OrgAccess> {
  const authenticated = await getCurrentUser();
  if (!authenticated) redirect(LOGIN_PATH);

  const access = await getOrgAccess(organizationId);
  if (!access) notFound();

  return access;
}

/**
 * Requires a specific permission within an organization.
 *
 * Also 404s on a permission failure, for the same reason as above: a developer
 * probing an admin-only route learns nothing about what exists.
 */
export async function requirePermission(
  organizationId: string,
  permission: Permission
): Promise<OrgAccess> {
  const access = await requireOrgAccess(organizationId);
  if (!hasPermission(access.role, permission)) notFound();

  return access;
}

/**
 * Accepts only same-site absolute paths.
 *
 * Rejects absolute URLs, protocol-relative URLs (`//evil.com`, which a browser
 * treats as another origin), and anything with a backslash, which some clients
 * normalise to a forward slash.
 */
export function safeRedirectPath(candidate: string | undefined | null): string | undefined {
  if (!candidate) return undefined;
  if (!candidate.startsWith('/')) return undefined;
  if (candidate.startsWith('//')) return undefined;
  if (candidate.includes('\\')) return undefined;
  if (candidate.includes('://')) return undefined;

  return candidate;
}
