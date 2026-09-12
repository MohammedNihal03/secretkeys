import { describe, expect, it } from 'vitest';

import { assessProvider, errorRatePercent, type AiProviderState } from '@/lib/evaluation/ai';
import { assessSnapshot, assessStoredMetrics } from '@/lib/evaluation/database';
import {
  aggregate,
  evaluate,
  evaluateAll,
  levelFor,
  rankFindings,
  type HealthLevel,
} from '@/lib/evaluation/engine';
import {
  allThresholds,
  DATABASE_THRESHOLDS,
  thresholdFor,
  type ThresholdRule,
} from '@/lib/evaluation/thresholds';
import type { DatabaseSnapshot } from '@/lib/databases/types';

/**
 * The health evaluation engine.
 *
 * The two things worth protecting with tests: that one threshold table is the
 * only source of a colour, and that a metric nobody could read comes out as
 * `unknown` rather than as green.
 */

const connectionRule = thresholdFor('connections.utilizationPercent') as ThresholdRule;

describe('thresholds', () => {
  it('keeps the build plan’s worked example exactly', () => {
    // Connections < 70% healthy, 70-85% warning, > 85% critical.
    expect(levelFor(connectionRule, 69.9)).toBe('healthy');
    expect(levelFor(connectionRule, 70)).toBe('warning');
    expect(levelFor(connectionRule, 85)).toBe('critical');
    expect(levelFor(connectionRule, 99)).toBe('critical');
  });

  it('reverses for a metric where smaller is worse', () => {
    const cache = thresholdFor('postgres.cacheHitRatioInterval') as ThresholdRule;

    expect(cache.direction).toBe('below');
    expect(levelFor(cache, 99)).toBe('healthy');
    expect(levelFor(cache, 95)).toBe('warning');
    expect(levelFor(cache, 90)).toBe('critical');
  });

  it('gives every rule a reason an operator can read', () => {
    for (const rule of allThresholds()) {
      expect(rule.rationale.length).toBeGreaterThan(20);
      expect(rule.label.length).toBeGreaterThan(0);
    }
  });

  it('never defines the same metric twice', () => {
    const metrics = allThresholds().map((rule) => rule.metric);
    expect(new Set(metrics).size).toBe(metrics.length);
  });
});

describe('evaluating one reading', () => {
  it('explains a breach in the metric’s own units', () => {
    const finding = evaluate({ metric: 'connections.utilizationPercent', value: 88 });

    expect(finding?.level).toBe('critical');
    expect(finding?.message).toContain('88%');
    expect(finding?.message).toContain('85%');
  });

  it('returns unknown, with the reason, for a metric that could not be read', () => {
    const finding = evaluate({
      metric: 'connections.utilizationPercent',
      value: null,
      reason: 'insufficient_privilege',
      detail: 'The monitoring role cannot see other users’ backends.',
    });

    expect(finding?.level).toBe('unknown');
    expect(finding?.reason).toBe('insufficient_privilege');
    expect(finding?.message).toContain('monitoring role');
  });

  it('declines to judge a metric it has no rule for', () => {
    // Not the same as "this is fine": the caller should show the number plainly.
    expect(evaluate({ metric: 'postgres.temporaryFiles', value: 900_000 })).toBeNull();
  });

  it('turns a rule with no reading into an explicit unknown', () => {
    const findings = evaluateAll([], DATABASE_THRESHOLDS);

    expect(findings).toHaveLength(DATABASE_THRESHOLDS.length);
    expect(findings.every((finding) => finding.level === 'unknown')).toBe(true);
    // A dropped rule would read as "disk is fine" rather than "nothing watches disk".
    expect(findings.some((finding) => finding.metric === 'resources.diskUsedPercent')).toBe(true);
  });
});

describe('rolling levels up', () => {
  it('lets the worst level win', () => {
    expect(aggregate(['healthy', 'warning', 'critical'])).toBe('critical');
    expect(aggregate(['healthy', 'warning'])).toBe('warning');
    expect(aggregate(['healthy', 'healthy'])).toBe('healthy');
  });

  it('puts unknown above healthy but below a known problem', () => {
    // Green while half the inputs are unreadable is the failure to avoid.
    expect(aggregate(['healthy', 'unknown'])).toBe('unknown');
    // And a known problem is the more actionable thing to surface.
    expect(aggregate(['unknown', 'warning'])).toBe('warning');
    expect(aggregate([])).toBe('unknown');
  });

  it('ranks findings so the worst is first', () => {
    const levels: HealthLevel[] = ['healthy', 'critical', 'unknown', 'warning'];
    const ranked = rankFindings(
      levels.map((level, index) => ({
        metric: `m${index}`,
        label: `Metric ${index}`,
        level,
        value: 1,
        unit: null,
        message: '',
      }))
    );

    expect(ranked.map((finding) => finding.level)).toEqual([
      'critical',
      'warning',
      'unknown',
      'healthy',
    ]);
  });
});

/** A snapshot with everything readable, which individual tests then spoil. */
function snapshot(overrides: Partial<DatabaseSnapshot> = {}): DatabaseSnapshot {
  const ok = <T>(value: T) => ({ available: true as const, value });
  const missing = (
    reason: 'not_exposed_by_postgres' | 'insufficient_privilege',
    detail: string
  ) => ({ available: false as const, reason, detail });

  return {
    target: {
      organizationId: 'org-1',
      organizationName: 'Acme',
      projectId: 'project-1',
      projectName: 'FYIND',
      databaseId: 'db-1',
      name: 'Production Primary',
      host: 'db.internal',
      port: 5432,
      databaseName: 'app',
      username: 'observability',
      sslEnabled: true,
      environment: 'production',
    },
    startedAt: new Date('2026-09-12T10:00:00Z'),
    finishedAt: new Date('2026-09-12T10:00:01Z'),
    durationMs: 1_000,
    outcome: 'success',
    status: 'healthy',
    health: {
      reachable: true,
      responseTimeMs: 20,
      connectTimeMs: 4,
      serverVersion: ok('16.4'),
      inRecovery: ok(false),
      uptimeSeconds: ok(86_400),
    },
    resources: {
      databaseSizeBytes: ok(1_000),
      clusterSizeBytes: ok(2_000),
      storageGrowthBytesPerDay: ok(10),
      cpuPercent: missing('not_exposed_by_postgres', 'PostgreSQL does not report host CPU.'),
      memoryPercent: missing('not_exposed_by_postgres', 'PostgreSQL does not report host memory.'),
      diskFreeBytes: missing('not_exposed_by_postgres', 'PostgreSQL does not report free disk.'),
    },
    connections: {
      current: ok(20),
      max: ok(100),
      reservedForSuperusers: ok(3),
      active: ok(2),
      idle: ok(15),
      idleInTransaction: ok(1),
      onThisDatabase: ok(18),
      utilizationPercent: ok(20),
    },
    queries: {
      active: ok(2),
      slow: ok(0),
      longRunning: ok(0),
      longestRunningSeconds: ok(3),
      blocked: ok(0),
      waitingLocks: ok(0),
      rolledBackTransactions: ok(25),
      rollbacksInInterval: ok(1),
      deadlocks: ok(0),
      deadlocksInInterval: ok(0),
    },
    postgres: {
      committedTransactions: ok(1_000),
      transactionsPerSecond: ok(5),
      cacheHitRatioInterval: ok(99.5),
      cacheHitRatioSinceReset: ok(99),
      blocksHit: ok(9_500),
      blocksRead: ok(500),
      temporaryFiles: ok(0),
      temporaryBytes: ok(0),
      statsResetAt: ok(null),
      statementStatsAvailable: ok(true),
    },
    privileges: {
      isSuperuser: false,
      hasPgMonitor: true,
      hasReadAllStats: false,
      hiddenBackends: 0,
    },
    counters: null,
    notes: [],
    ...overrides,
  } as DatabaseSnapshot;
}

describe('assessing a database', () => {
  it('stays healthy when the only unknowns are ones PostgreSQL can never report', () => {
    const assessment = assessSnapshot(snapshot());

    /**
     * CPU, memory and disk are unreadable and always will be. Letting them
     * decide would paint every healthy database amber forever, which is how a
     * status indicator stops being read.
     */
    expect(assessment.level).toBe('healthy');

    // Still shown, still explained, and the headline says how many.
    const structural = assessment.findings.filter((finding) => finding.structural);
    expect(structural.map((finding) => finding.metric)).toEqual(
      expect.arrayContaining([
        'resources.cpuPercent',
        'resources.memoryPercent',
        'resources.diskUsedPercent',
      ])
    );
    expect(assessment.headline).toContain('PostgreSQL cannot report');
  });

  it('is unknown when a metric could be read but was not', () => {
    const base = snapshot();
    const assessment = assessSnapshot(
      snapshot({
        connections: {
          ...base.connections,
          utilizationPercent: {
            available: false,
            reason: 'insufficient_privilege',
            detail: 'The monitoring role cannot see other users’ backends.',
          },
        },
      })
    );

    // A missing GRANT is a fixable absence, so it does reach the rollup.
    expect(assessment.level).toBe('unknown');
    expect(assessment.headline).toContain('1 of its metrics could not be read');
  });

  it('reports an unreachable database as critical before anything else', () => {
    const assessment = assessSnapshot(
      snapshot({
        health: { ...snapshot().health, reachable: false },
        error: 'connect ECONNREFUSED',
      })
    );

    expect(assessment.level).toBe('critical');
    expect(assessment.unreachable).toBe(true);
    // One fact, not nine unknowns burying it.
    expect(assessment.findings).toHaveLength(1);
    expect(assessment.headline).toContain('ECONNREFUSED');
  });

  it('surfaces the worst breach in the headline', () => {
    const base = snapshot();
    const assessment = assessSnapshot(
      snapshot({
        connections: { ...base.connections, utilizationPercent: { available: true, value: 91 } },
        queries: { ...base.queries, blocked: { available: true, value: 2 } },
      })
    );

    expect(assessment.level).toBe('critical');
    expect(assessment.headline).toContain('Connection utilization');
    expect(assessment.findings[0].metric).toBe('connections.utilizationPercent');
  });

  it('says so plainly when a database has never been collected', () => {
    const assessment = assessStoredMetrics('Production Primary', []);

    expect(assessment.level).toBe('unknown');
    expect(assessment.headline).toContain('No metrics');
  });

  it('judges stored readings the same way as a fresh snapshot', () => {
    const assessment = assessStoredMetrics('Production Primary', [
      {
        metric: 'connections.utilizationPercent',
        samples: 10,
        readings: 10,
        min: 10,
        max: 91,
        average: 40,
        latest: 91,
        latestAt: new Date('2026-09-12T10:00:00Z'),
        latestReason: null,
        latestDetail: null,
        latestText: null,
      },
    ]);

    expect(assessment.level).toBe('critical');
    expect(assessment.findings[0].metric).toBe('connections.utilizationPercent');
  });
});

function providerState(overrides: Partial<AiProviderState> = {}): AiProviderState {
  return {
    name: 'OpenAI',
    providerStatus: 'healthy',
    latencyMs: 300,
    rateLimited: false,
    lastCollectedAt: new Date('2026-09-12T10:00:00Z'),
    lastError: null,
    requests: 1_000,
    failedRequests: 5,
    quotaUsedPercent: null,
    rateLimitRemainingPercent: null,
    ...overrides,
  };
}

describe('assessing an AI provider', () => {
  it('computes an error rate only when both numbers exist', () => {
    expect(errorRatePercent(1_000, 25)).toBe(2.5);
    // Zero would claim every request succeeded.
    expect(errorRatePercent(1_000, null)).toBeNull();
    expect(errorRatePercent(null, 0)).toBeNull();
    expect(errorRatePercent(0, 0)).toBeNull();
  });

  it('raises a warning on a high error rate', () => {
    const assessment = assessProvider(providerState({ requests: 100, failedRequests: 15 }));

    expect(assessment.level).toBe('critical');
    expect(assessment.headline).toContain('error rate');
  });

  it('treats being rate limited as a fact, not a threshold', () => {
    const assessment = assessProvider(providerState({ rateLimited: true }));

    expect(assessment.level).toBe('warning');
    expect(assessment.findings[0].metric).toBe('ai.rateLimited');
    expect(assessment.findings[0].message).toContain('refused');
  });

  it('reports an unreachable provider as critical', () => {
    const assessment = assessProvider(
      providerState({ providerStatus: 'unhealthy', lastError: 'connect ETIMEDOUT' })
    );

    expect(assessment.level).toBe('critical');
    expect(assessment.headline).toContain('ETIMEDOUT');
  });

  it('judges a provider on what it does expose, and names what it does not', () => {
    const assessment = assessProvider(
      providerState({ name: 'Groq', requests: null, failedRequests: null, latencyMs: 120 })
    );

    /**
     * Groq exposes no usage at all, so its error rate and quota are structural
     * unknowns. Its latency is real and within threshold, so the credential is
     * healthy -- reporting it as unknown forever would be indistinguishable
     * from a broken integration.
     */
    expect(assessment.level).toBe('healthy');
    expect(
      assessment.findings.find((finding) => finding.metric === 'ai.errorRatePercent')
    ).toMatchObject({ level: 'unknown', structural: true });
    expect(
      assessment.findings.find((finding) => finding.metric === 'ai.errorRatePercent')?.message
    ).toContain('does not report usage');
  });

  it('is unknown when even latency was never measured', () => {
    const assessment = assessProvider(
      providerState({ requests: null, failedRequests: null, latencyMs: null })
    );

    // Nothing judgeable is left, so the state is honest about that.
    expect(assessment.level).toBe('unknown');
    expect(assessment.headline).toContain('little that can be judged');
  });

  it('is unknown before the first collection', () => {
    const assessment = assessProvider(
      providerState({ providerStatus: null, lastCollectedAt: null })
    );

    expect(assessment.level).toBe('unknown');
    expect(assessment.headline).toContain('not been collected');
  });
});
