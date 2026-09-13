import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetEnvCache } from '@/lib/env';
import { PUBLIC_DATABASE_ERROR, toPublicReport, type HealthReport } from '@/lib/health';

/**
 * Authorization for anything reachable over HTTP without a page guard.
 *
 * Three surfaces: the route-handler authorization helpers, the collector
 * trigger (reachable from the internet, authenticated by a shared secret), and
 * the public health report (reachable by anyone at all).
 */

const access = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getOrgAccess: vi.fn(),
}));

vi.mock('@/lib/auth/access', () => access);

const collector = vi.hoisted(() => ({
  runCollection: vi.fn(async () => ({ ran: true, targets: 0 })),
}));

vi.mock('@/lib/collector/runner', () => collector);

const ORG = '5f0b8f0e-3f5c-4e8e-9d6b-6a2f2c8f1a11';

describe('route-handler authorization', () => {
  beforeEach(() => {
    access.getCurrentUser.mockReset();
    access.getOrgAccess.mockReset();
  });

  it('returns 401 without a valid session', async () => {
    const { authorizeUser, authorizeOrg, authorizePermission } =
      await import('@/lib/api/authorize');
    access.getCurrentUser.mockResolvedValue(null);

    for (const result of [
      await authorizeUser(),
      await authorizeOrg(ORG),
      await authorizePermission(ORG, 'databases:manage'),
    ]) {
      expect(result.ok).toBe(false);
      expect(!result.ok && result.response.status).toBe(401);
    }
  });

  it('returns 404, not 403, to a signed-in non-member', async () => {
    const { authorizeOrg } = await import('@/lib/api/authorize');
    access.getCurrentUser.mockResolvedValue({ user: { id: 'u1' } });
    access.getOrgAccess.mockResolvedValue(null);

    const result = await authorizeOrg(ORG);

    // A 403 would confirm the organization exists to someone outside it.
    expect(!result.ok && result.response.status).toBe(404);
    expect(!result.ok && (await result.response.json())).toEqual({ error: 'Not found' });
  });

  it('returns 403 to a member whose role lacks the permission', async () => {
    const { authorizePermission } = await import('@/lib/api/authorize');
    access.getCurrentUser.mockResolvedValue({ user: { id: 'u1' } });
    access.getOrgAccess.mockResolvedValue({ organizationId: ORG, role: 'developer' });

    const result = await authorizePermission(ORG, 'databases:manage');

    expect(!result.ok && result.response.status).toBe(403);
  });

  it('lets an admin through, and never caches an authorization failure', async () => {
    const { authorizePermission, authorizeOrg } = await import('@/lib/api/authorize');
    access.getCurrentUser.mockResolvedValue({ user: { id: 'u1' } });
    access.getOrgAccess.mockResolvedValue({ organizationId: ORG, role: 'org_admin' });

    expect((await authorizePermission(ORG, 'databases:manage')).ok).toBe(true);

    access.getOrgAccess.mockResolvedValue(null);
    const denied = await authorizeOrg(ORG);
    expect(!denied.ok && denied.response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('the collector trigger', () => {
  const mutableEnv = process.env as Record<string, string | undefined>;
  const SECRET = 'a'.repeat(40);
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      DATABASE_URL: mutableEnv.DATABASE_URL,
      COLLECTOR_TRIGGER_SECRET: mutableEnv.COLLECTOR_TRIGGER_SECRET,
    };
    mutableEnv.DATABASE_URL = 'postgres://localhost:5432/test';
    collector.runCollection.mockClear();
    resetEnvCache();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete mutableEnv[key];
      else mutableEnv[key] = value;
    }
    resetEnvCache();
  });

  function trigger(headers: Record<string, string> = {}, query = '') {
    return new NextRequest(`http://localhost/api/collect${query}`, { method: 'POST', headers });
  }

  it('is disabled, not open, when no secret is configured', async () => {
    delete mutableEnv.COLLECTOR_TRIGGER_SECRET;
    const { POST } = await import('@/app/api/collect/route');

    const response = await POST(trigger({ authorization: `Bearer ${SECRET}` }));

    expect(response.status).toBe(503);
    expect(collector.runCollection).not.toHaveBeenCalled();
  });

  it('refuses a missing or wrong secret without collecting', async () => {
    mutableEnv.COLLECTOR_TRIGGER_SECRET = SECRET;
    const { POST } = await import('@/app/api/collect/route');

    const attempts: Record<string, string>[] = [
      {},
      { authorization: 'Bearer wrong' },
      { 'x-collector-secret': `${SECRET}x` },
    ];

    for (const headers of attempts) {
      const response = await POST(trigger(headers));
      expect(response.status).toBe(401);
    }

    expect(collector.runCollection).not.toHaveBeenCalled();
  });

  it('collects with the right secret, by either header', async () => {
    mutableEnv.COLLECTOR_TRIGGER_SECRET = SECRET;
    const { POST } = await import('@/app/api/collect/route');

    expect((await POST(trigger({ authorization: `Bearer ${SECRET}` }))).status).toBe(200);
    expect((await POST(trigger({ 'x-collector-secret': SECRET }))).status).toBe(200);
    expect(collector.runCollection).toHaveBeenCalledTimes(2);
  });

  it('rejects an organization filter that is not a UUID before collecting', async () => {
    mutableEnv.COLLECTOR_TRIGGER_SECRET = SECRET;
    const { POST } = await import('@/app/api/collect/route');

    const response = await POST(
      trigger({ authorization: `Bearer ${SECRET}` }, "?organizationId=1' or '1'='1")
    );

    expect(response.status).toBe(400);
    expect(collector.runCollection).not.toHaveBeenCalled();
  });

  it('refuses to boot with a secret short enough to guess', async () => {
    mutableEnv.COLLECTOR_TRIGGER_SECRET = 'short-secret';
    const { getEnv } = await import('@/lib/env');

    expect(() => getEnv()).toThrow(/COLLECTOR_TRIGGER_SECRET/);
    // And the message names the variable, never the value.
    expect(() => getEnv()).not.toThrow(/short-secret/);
  });
});

describe('the public health report', () => {
  const report: HealthReport = {
    status: 'unhealthy',
    version: '0.1.0',
    uptimeSeconds: 12,
    timestamp: '2026-09-13T00:00:00.000Z',
    checks: {
      database: {
        status: 'unhealthy',
        latencyMs: 4,
        error: 'password authentication failed for user "observability_admin"',
      },
    },
  };

  it('replaces the driver message, which names the database role', () => {
    const shown = toPublicReport(report);

    expect(shown.checks.database.error).toBe(PUBLIC_DATABASE_ERROR);
    expect(JSON.stringify(shown)).not.toContain('observability_admin');
    // What a load balancer needs is untouched.
    expect(shown.status).toBe('unhealthy');
    expect(shown.checks.database.latencyMs).toBe(4);
  });

  it('adds no error to a healthy report', () => {
    const healthy = toPublicReport({
      ...report,
      status: 'healthy',
      checks: { database: { status: 'healthy', latencyMs: 3 } },
    });

    expect(healthy.checks.database.error).toBeUndefined();
  });
});
