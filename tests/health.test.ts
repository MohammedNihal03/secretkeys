import { describe, expect, it, vi } from 'vitest';

import { HEALTH_THRESHOLDS, aggregateStatus, type HealthStatus } from '@/lib/health';

vi.mock('@/lib/db/client', () => ({
  getPool: vi.fn(() => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
  }),
}));

describe('aggregateStatus', () => {
  it('reports healthy only when every check is healthy', () => {
    expect(aggregateStatus(['healthy', 'healthy'])).toBe('healthy');
  });

  it.each<[HealthStatus[], HealthStatus]>([
    [['healthy', 'degraded'], 'degraded'],
    [['healthy', 'unknown'], 'unknown'],
    [['degraded', 'unknown'], 'degraded'],
    [['healthy', 'degraded', 'unhealthy'], 'unhealthy'],
    [['unknown', 'unhealthy'], 'unhealthy'],
  ])('lets the worst status win: %j -> %s', (input, expected) => {
    expect(aggregateStatus(input)).toBe(expected);
  });

  it('is unknown when there is nothing to evaluate', () => {
    expect(aggregateStatus([])).toBe('unknown');
  });
});

describe('checkDatabase', () => {
  it('reports unhealthy instead of throwing when the database is unreachable', async () => {
    const { checkDatabase } = await import('@/lib/health');

    const result = await checkDatabase();

    expect(result.status).toBe('unhealthy');
    expect(result.error).toContain('ECONNREFUSED');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('thresholds', () => {
  it('keeps the probe timeout above the degraded latency boundary', () => {
    // A probe that times out before it can be called slow would make the
    // `degraded` state unreachable.
    expect(HEALTH_THRESHOLDS.dbProbeTimeoutMs).toBeGreaterThan(
      HEALTH_THRESHOLDS.dbLatencyDegradedMs
    );
  });
});
