import type { OrgRole } from '@/lib/db/schema';

/**
 * Role-based access control.
 *
 * The matrix below is the single definition of what each role may do. Route
 * handlers and UI both consult it, so a permission is never re-derived from a
 * role comparison scattered through the codebase -- `role === 'org_admin'`
 * checks are exactly how permission drift starts.
 */

/**
 * Every distinct capability in the system.
 *
 * `manage` implies read and write of that resource, including its
 * credentials where it has them.
 */
export const PERMISSIONS = [
  'projects:manage',
  'providers:manage',
  'api_keys:manage',
  'databases:manage',
  'metrics:view',
  'health:view',
  'alerts:view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Role capabilities.
 *
 * Typed as a total record over `OrgRole`, so adding a role to the database enum
 * fails to compile until its permissions are declared here. A new role
 * defaulting to "no permissions" silently would be worse than a build error.
 */
const ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  /** Full control of the organization's monitoring configuration. */
  org_admin: PERMISSIONS,

  /**
   * Read-only. A developer can see everything the dashboard has collected but
   * cannot register credentials or change what is monitored.
   */
  developer: ['metrics:view', 'health:view', 'alerts:view'],
};

export function permissionsForRole(role: OrgRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function hasPermission(role: OrgRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** True when the role may perform every one of the given permissions. */
export function hasAllPermissions(role: OrgRole, permissions: readonly Permission[]): boolean {
  return permissions.every((permission) => hasPermission(role, permission));
}

/**
 * Permissions that mutate configuration.
 *
 * Useful for coarse UI decisions such as whether to render an admin nav at
 * all, without enumerating each capability at the call site.
 */
export const WRITE_PERMISSIONS: readonly Permission[] = [
  'projects:manage',
  'providers:manage',
  'api_keys:manage',
  'databases:manage',
];

export function canManageAnything(role: OrgRole): boolean {
  return WRITE_PERMISSIONS.some((permission) => hasPermission(role, permission));
}
