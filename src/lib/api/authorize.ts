import { getCurrentUser, getOrgAccess, type OrgAccess } from '@/lib/auth/access';
import { hasPermission, type Permission } from '@/lib/auth/permissions';
import type { AuthenticatedUser } from '@/lib/auth/session';

/**
 * Authorization for route handlers.
 *
 * Pages redirect; an API must return a status code. These helpers return a
 * discriminated result so a handler cannot accidentally proceed after a failed
 * check -- there is no "authorized" value to read unless `ok` is true.
 *
 * Status codes, and why:
 *
 *   401  no valid session
 *   404  signed in, but not a member of the organization -- deliberately
 *        indistinguishable from an organization that does not exist, so an
 *        account cannot be used to probe for other tenants
 *   403  a member, but the role lacks the permission -- safe to be explicit,
 *        since membership already reveals the organization
 */

export type AuthResult<T> = { ok: true; value: T } | { ok: false; response: Response };

function errorResponse(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Requires a valid session. */
export async function authorizeUser(): Promise<AuthResult<AuthenticatedUser>> {
  const authenticated = await getCurrentUser();

  if (!authenticated) {
    return { ok: false, response: errorResponse(401, 'Authentication required') };
  }

  return { ok: true, value: authenticated };
}

/** Requires membership of an organization. */
export async function authorizeOrg(organizationId: string): Promise<AuthResult<OrgAccess>> {
  const authenticated = await getCurrentUser();

  if (!authenticated) {
    return { ok: false, response: errorResponse(401, 'Authentication required') };
  }

  const access = await getOrgAccess(organizationId);

  if (!access) {
    return { ok: false, response: errorResponse(404, 'Not found') };
  }

  return { ok: true, value: access };
}

/** Requires a permission within an organization. */
export async function authorizePermission(
  organizationId: string,
  permission: Permission
): Promise<AuthResult<OrgAccess>> {
  const result = await authorizeOrg(organizationId);
  if (!result.ok) return result;

  if (!hasPermission(result.value.role, permission)) {
    return {
      ok: false,
      response: errorResponse(403, `Requires permission: ${permission}`),
    };
  }

  return result;
}
