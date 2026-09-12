import { desc, eq, sql } from 'drizzle-orm';

import { latestMetricsByDatabase } from '@/lib/databases/storage';
import { getDb } from '@/lib/db/client';
import { aiProviders, apiKeys, collectorRuns, monitoredDatabases } from '@/lib/db/schema';
import { assessProviders, type AiProviderState } from '@/lib/evaluation/ai';
import { assessStoredMetrics, type DatabaseAssessment } from '@/lib/evaluation/database';
import { aggregate, type Finding, type HealthLevel } from '@/lib/evaluation/engine';
import { listProjects } from '@/lib/projects/repository';
import { listProviderSelection } from '@/lib/providers/selection';
import {
  summarizeUsage,
  usageBreakdown,
  usageTimeSeries,
  type UsageSeriesPoint,
  type UsageTotals,
} from '@/lib/usage/repository';

/**
 * Everything the organization dashboard shows, assembled once.
 *
 * Every figure here is read from a table a collector wrote. Nothing is
 * simulated, and nothing is filled in to make a card look complete: where a
 * provider reports no usage, or a database has never been collected from, that
 * is what reaches the page, with the reason attached.
 *
 * Assembled in one place rather than per component so the page makes a fixed
 * number of queries regardless of how many cards it renders.
 */

export interface ProviderPanel extends AiProviderState {
  providerId: string;
  keyCount: number;
  level: HealthLevel;
  headline: string;
  findings: Finding[];
  estimatedCost: number | null;
  totalTokens: number | null;
}

export interface DatabasePanel {
  databaseId: string;
  name: string;
  environment: string;
  assessment: DatabaseAssessment;
  lastCheckedAt: Date | null;
  responseTimeMs: number | null;
  connections: number | null;
  connectionUtilization: number | null;
  sizeBytes: number | null;
  collected: boolean;
}

export interface DashboardOverview {
  level: HealthLevel;
  window: { from: Date; to: Date; days: number };

  setup: {
    projects: number;
    apiKeys: number;
    databases: number;
    providersTracked: number;
    providersAvailable: number;
  };

  ai: {
    level: HealthLevel;
    providers: ProviderPanel[];
    totals: UsageTotals;
    series: UsageSeriesPoint[];
    lastCollectedAt: Date | null;
    /** True once any collection has run, whatever it found. */
    collected: boolean;
  };

  databases: {
    level: HealthLevel;
    items: DatabasePanel[];
    lastCheckedAt: Date | null;
    collected: boolean;
  };

  /** Everything currently wrong, worst first, across both halves. */
  attention: { source: string; level: HealthLevel; message: string }[];
  /** The most recent failures, so an operator can see what broke and when. */
  recentErrors: { source: string; at: Date; message: string }[];
}

const LEVEL_RANK: Record<HealthLevel, number> = {
  critical: 0,
  warning: 1,
  unknown: 2,
  healthy: 3,
};

/** Reads a metric out of a database's latest readings. */
function reading(metrics: { metric: string; latest: number | null }[], path: string) {
  return metrics.find((entry) => entry.metric === path)?.latest ?? null;
}

export async function loadDashboardOverview(
  organizationId: string,
  options: { days?: number; now?: () => Date } = {}
): Promise<DashboardOverview> {
  const now = options.now ?? (() => new Date());
  const days = options.days ?? 7;
  const to = now();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const range = { organizationId, from, to };

  const db = getDb();

  /**
   * The newest collector run per provider.
   *
   * `distinct on` gives "the latest per group" in one index scan; the portable
   * alternatives are a self-join or a window function over the whole history.
   */
  const latestRuns = await db.execute<{
    provider_id: string;
    provider_name: string;
    started_at: Date;
    provider_status: HealthLevel | 'degraded' | 'unhealthy';
    latency_ms: number | null;
    rate_limited: boolean;
    error: string | null;
  }>(sql`
    select distinct on (${collectorRuns.providerId})
      ${collectorRuns.providerId} as provider_id,
      ${aiProviders.name} as provider_name,
      ${collectorRuns.startedAt} as started_at,
      ${collectorRuns.providerStatus} as provider_status,
      ${collectorRuns.latencyMs} as latency_ms,
      ${collectorRuns.rateLimited} as rate_limited,
      ${collectorRuns.error} as error
    from ${collectorRuns}
    join ${aiProviders} on ${aiProviders.id} = ${collectorRuns.providerId}
    where ${collectorRuns.organizationId} = ${organizationId}
    order by ${collectorRuns.providerId}, ${collectorRuns.startedAt} desc
  `);

  const [projects, selection, totals, series, providerUsage, keyCounts, databases] =
    await Promise.all([
      listProjects(organizationId),
      listProviderSelection(organizationId),
      summarizeUsage(range),
      usageTimeSeries(range, days > 2 ? 'day' : 'hour'),
      usageBreakdown(range, 'provider'),
      db
        .select({ providerId: apiKeys.providerId, count: sql<number>`count(*)::int` })
        .from(apiKeys)
        .where(eq(apiKeys.organizationId, organizationId))
        .groupBy(apiKeys.providerId),
      db
        .select({
          id: monitoredDatabases.id,
          name: monitoredDatabases.name,
          environment: monitoredDatabases.environment,
          status: monitoredDatabases.status,
          lastCheckedAt: monitoredDatabases.lastCheckedAt,
          lastCheckStatus: monitoredDatabases.lastCheckStatus,
          lastCheckDetail: monitoredDatabases.lastCheckDetail,
        })
        .from(monitoredDatabases)
        .where(eq(monitoredDatabases.organizationId, organizationId))
        .orderBy(desc(monitoredDatabases.lastCheckedAt)),
    ]);

  const usageByProvider = new Map(providerUsage.map((row) => [row.id, row]));
  const keysByProvider = new Map(keyCounts.map((row) => [row.providerId, row.count]));

  /**
   * Only providers this organization actually tracks and holds a key for. A
   * card for a provider with no credential would be a permanent "unknown" that
   * nobody can fix except by removing it.
   */
  const trackedProviders = selection.filter(
    (entry) => entry.enabled && (keysByProvider.get(entry.providerId) ?? 0) > 0
  );

  const states: AiProviderState[] = trackedProviders.map((entry) => {
    const run = latestRuns.rows.find((row) => row.provider_id === entry.providerId);
    const usage = usageByProvider.get(entry.providerId);

    return {
      name: entry.displayName,
      providerStatus: run ? (run.provider_status as AiProviderState['providerStatus']) : null,
      latencyMs: run?.latency_ms ?? null,
      rateLimited: run?.rate_limited ?? false,
      lastCollectedAt: run?.started_at ?? null,
      lastError: run?.error ?? null,
      requests: usage?.requests ?? null,
      failedRequests: usage?.failedRequests ?? null,
      quotaUsedPercent: null,
      rateLimitRemainingPercent: null,
    };
  });

  const assessedProviders = assessProviders(states);

  const providers: ProviderPanel[] = trackedProviders.map((entry, index) => {
    const usage = usageByProvider.get(entry.providerId);
    const assessment = assessedProviders.assessments[index];

    return {
      ...states[index],
      providerId: entry.providerId,
      keyCount: keysByProvider.get(entry.providerId) ?? 0,
      level: assessment.level,
      headline: assessment.headline,
      findings: assessment.findings,
      estimatedCost: usage?.estimatedCost ?? null,
      totalTokens: usage?.totalTokens ?? null,
    };
  });

  const metricsByDatabase = await latestMetricsByDatabase(organizationId, from);

  const databasePanels: DatabasePanel[] = databases.map((row) => {
    const metrics = metricsByDatabase.get(row.id) ?? [];
    const collected = metrics.length > 0;

    const assessment = assessStoredMetrics(row.name, metrics, {
      // A failed check is the fact that matters, even with stale metrics behind it.
      reachable: row.lastCheckStatus === 'unhealthy' ? false : undefined,
      error: row.lastCheckDetail,
    });

    return {
      databaseId: row.id,
      name: row.name,
      environment: row.environment,
      assessment,
      lastCheckedAt: row.lastCheckedAt,
      responseTimeMs: reading(metrics, 'health.responseTimeMs'),
      connections: reading(metrics, 'connections.current'),
      connectionUtilization: reading(metrics, 'connections.utilizationPercent'),
      sizeBytes: reading(metrics, 'resources.databaseSizeBytes'),
      collected,
    };
  });

  const databaseLevel = aggregate(databasePanels.map((panel) => panel.assessment.level));
  const aiLevel = assessedProviders.level;

  const attention = [
    ...providers.flatMap((provider) =>
      provider.findings
        .filter((finding) => finding.level === 'critical' || finding.level === 'warning')
        .map((finding) => ({
          source: provider.name,
          level: finding.level,
          message: finding.message,
        }))
    ),
    ...databasePanels.flatMap((panel) =>
      panel.assessment.findings
        .filter((finding) => finding.level === 'critical' || finding.level === 'warning')
        .map((finding) => ({
          source: panel.name,
          level: finding.level,
          message: finding.message,
        }))
    ),
  ].sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);

  const recentErrors = [
    ...latestRuns.rows
      .filter((row) => row.error)
      .map((row) => ({
        source: row.provider_name,
        at: row.started_at,
        message: row.error as string,
      })),
    ...databases
      .filter((row) => row.lastCheckStatus === 'unhealthy' && row.lastCheckDetail)
      .map((row) => ({
        source: row.name,
        at: row.lastCheckedAt ?? to,
        message: row.lastCheckDetail as string,
      })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 5);

  const aiCollected = latestRuns.rows.length > 0;
  const databasesCollected = databasePanels.some((panel) => panel.collected);

  return {
    /**
     * The organization's level is the worst of the two halves. Rolling up to
     * "healthy" while one database is critical would be the one thing a status
     * page must never do.
     */
    level: aggregate(
      [aiCollected ? aiLevel : null, databases.length > 0 ? databaseLevel : null].filter(
        (level): level is HealthLevel => level !== null
      )
    ),
    window: { from, to, days },

    setup: {
      projects: projects.length,
      apiKeys: projects.reduce((sum, project) => sum + project.apiKeyCount, 0),
      databases: databases.length,
      providersTracked: selection.filter((entry) => entry.enabled).length,
      providersAvailable: selection.length,
    },

    ai: {
      level: aiLevel,
      providers,
      totals,
      series,
      lastCollectedAt:
        latestRuns.rows.map((row) => row.started_at).sort((a, b) => b.getTime() - a.getTime())[0] ??
        null,
      collected: aiCollected,
    },

    databases: {
      level: databaseLevel,
      items: databasePanels,
      lastCheckedAt:
        databases
          .map((row) => row.lastCheckedAt)
          .filter((at): at is Date => at !== null)
          .sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
      collected: databasesCollected,
    },

    attention,
    recentErrors,
  };
}
