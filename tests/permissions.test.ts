import { describe, expect, it } from 'vitest';

import {
  PERMISSIONS,
  WRITE_PERMISSIONS,
  canManageAnything,
  hasAllPermissions,
  hasPermission,
  permissionsForRole,
  type Permission,
} from '@/lib/auth/permissions';
import { generateSessionToken, hashSessionToken } from '@/lib/auth/session';
import { safeRedirectPath } from '@/lib/auth/guards';

/**
 * The role matrix is the definition of what each role may do, so it is pinned
 * here explicitly. A permission silently widening -- a developer gaining
 * `api_keys:manage`, say -- would be a privilege escalation that no other test
 * would catch.
 */

describe('org_admin', () => {
  it('holds every permission', () => {
    expect(permissionsForRole('org_admin')).toEqual(PERMISSIONS);
  });

  it.each(PERMISSIONS)('may %s', (permission) => {
    expect(hasPermission('org_admin', permission)).toBe(true);
  });
});

describe('developer', () => {
  it('is read-only', () => {
    expect([...permissionsForRole('developer')].sort()).toEqual(
      ['alerts:view', 'health:view', 'metrics:view'].sort()
    );
  });

  it.each(WRITE_PERMISSIONS)('may NOT %s', (permission) => {
    expect(hasPermission('developer', permission)).toBe(false);
  });

  it.each(['metrics:view', 'health:view', 'alerts:view'] as Permission[])(
    'may %s',
    (permission) => {
      expect(hasPermission('developer', permission)).toBe(true);
    }
  );

  it('cannot manage anything', () => {
    expect(canManageAnything('developer')).toBe(false);
    expect(canManageAnything('org_admin')).toBe(true);
  });
});

describe('hasAllPermissions', () => {
  it('requires every listed permission', () => {
    expect(hasAllPermissions('developer', ['metrics:view', 'alerts:view'])).toBe(true);
    expect(hasAllPermissions('developer', ['metrics:view', 'api_keys:manage'])).toBe(false);
    expect(hasAllPermissions('org_admin', [...PERMISSIONS])).toBe(true);
  });

  it('is vacuously true for an empty list', () => {
    expect(hasAllPermissions('developer', [])).toBe(true);
  });
});

describe('session tokens', () => {
  it('generates a high-entropy token each time', () => {
    const tokens = new Set(Array.from({ length: 200 }, generateSessionToken));

    // 32 random bytes: a collision in 200 draws would mean a broken CSPRNG.
    expect(tokens.size).toBe(200);
    // base64url of 32 bytes, so no padding and no URL-unsafe characters.
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes deterministically, and never stores the token itself', () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);

    expect(hash).toBe(hashSessionToken(token));
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(token);
    expect(hashSessionToken(generateSessionToken())).not.toBe(hash);
  });
});

describe('safeRedirectPath', () => {
  it('accepts same-site absolute paths', () => {
    expect(safeRedirectPath('/')).toBe('/');
    expect(safeRedirectPath('/organizations/abc?tab=keys')).toBe('/organizations/abc?tab=keys');
  });

  // Each of these would turn the sign-in page into an open redirect, sending a
  // user who just authenticated to an attacker's site.
  it.each([
    ['absolute URL', 'https://evil.example.com'],
    ['protocol-relative', '//evil.example.com'],
    ['scheme in path', '/redirect?to=https://evil.example.com/x://'],
    ['backslash host', '/\\evil.example.com'],
    ['relative path', 'dashboard'],
    ['empty', ''],
  ])('rejects %s', (_label, candidate) => {
    expect(safeRedirectPath(candidate)).toBeUndefined();
  });

  it('rejects nullish input', () => {
    expect(safeRedirectPath(undefined)).toBeUndefined();
    expect(safeRedirectPath(null)).toBeUndefined();
  });
});
