import { and, desc, eq, gte, sql } from 'drizzle-orm';

import { getDb } from '@/lib/db/client';
import { aiProviders, apiKeys, collectorRuns, projects } from '@/lib/db/schema';
import { assessProvider, type AiAssessment, type AiProviderState } from '@/lib/evaluation/ai';
import {
  summarizeUsage,
  usageBreakdown,
  usageTimeSeries,
  type UsageBreakdownRow,
  type UsageQuery,
  type UsageSeriesPoint,
  type UsageTotals,
} from '@/lib/usage/repository';

/**
 * The AI analytics reads.
 *
 * One module for the provider, key and project views, because all three are the
 * same question asked at different points in the hierarchy -- and answering
 * them in the same way is what makes the three pages agree. A project total
 * that did not equal the sum of its keys would be worse than no total at all.
 *
 * Every figure comes from `ai_usage` and `collector_runs`. Nothing is
 * apportioned, estimated or carried over.
 */

export interface CollectionState {
  providerStatus: 'healthy' | 'degraded' | 'unhealthy' | 'unknown' | null;
  latencyMs: number | null;
  rateLimited: boolean;
  lastCollectedAt: Date | null;
  lastError: string | null;
  /** Collections in the window, and how many of them failed. */
  runs: number;
  failures: number;
}

const EMPTY_STATE: CollectionState = {
  providerStatus: null,
  latencyMs: null,
  rateLimited: false,
  lastCollectedAt: null,
  lastError: null,
  runs: 0,
  failures: 0,
};

/**
 * What collection has observed for one credential, or for a whole provider.
 *
 * The counts come from the same rows as the status, so "healthy now" and "four
 * failures today" can both be true and both be shown.
 */
export async function collectionState(
  organizationId: string,
  scope: { apiKeyId?: string; providerId?: string },
  since: Date
): Promise<CollectionState> {
  const clauses = [eq(collectorRuns.organizationId, organizationId)];

  if (scope.apiKeyId) clauses.push(eq(collectorRuns.apiKeyId, scope.apiKeyId));
  if (scope.providerId) clauses.push(eq(collectorRuns.providerId, scope.providerId));

  const db = getDb();

  const [[latest], [counts]] = await Promise.all([
    db
      .select({
        providerStatus: collectorRuns.providerStatus,
        latencyMs: collectorRuns.latencyMs,
        rateLimited: collectorRuns.rateLimited,
        startedAt: collectorRuns.startedAt,
        error: collectorRuns.error,
      })
      .from(collectorRuns)
      .where(and(...clauses))
      .orderBy(desc(collectorRuns.startedAt))
      .limit(1),
    db
      .select({
        runs: sql<number>`count(*)::int`,
        failures: sql<number>`count(*) filter (where ${collectorRuns.outcome} = 'failed')::int`,
      })
      .from(collectorRuns)
      .where(and(...clauses, gte(collectorRuns.startedAt, since))),
  ]);

  if (!latest) return { ...EMPTY_STATE, runs: counts?.runs ?? 0, failures: counts?.failures ?? 0 };

  return {
    providerStatus: latest.providerStatus,
    latencyMs: latest.latencyMs,
    rateLimited: latest.rateLimited,
    lastCollectedAt: latest.startedAt,
    lastError: latest.error,
    runs: counts?.runs ?? 0,
    failures: counts?.failures ?? 0,
  };
}

export interface AnalyticsView {
  totals: UsageTotals;
  series: UsageSeriesPoint[];
  collection: CollectionState;
  assessment: AiAssessment;
}

/** Turns collected state and usage into the evaluated view a page renders. */
export function assessFrom(
  name: string,
  collection: CollectionState,
  totals: UsageTotals
): AiAssessment {
  const state: AiProviderState = {
    name,
    providerStatus: collection.providerStatus,
    latencyMs: collection.latencyMs,
    rateLimited: collection.rateLimited,
    lastCollectedAt: collection.lastCollectedAt,
    lastError: collection.lastError,
    requests: totals.requests,
    failedRequests: totals.failedRequests,
    quotaUsedPercent: null,
    rateLimitRemainingPercent: null,
  };

  return assessProvider(state);
}

export interface ProviderAnalytics extends AnalyticsView {
  provider: { id: string; name: string; type: string };
  keys: (UsageBreakdownRow & { environment: string; projectName: string })[];
}

export async function loadProviderAnalytics(
  organizationId: string,
  providerId: string,
  window: { from: Date; to: Date }
): Promise<ProviderAnalytics | null> {
  const db = getDb();

  const [provider] = await db
    .select({ id: aiProviders.id, name: aiProviders.name, type: aiProviders.type })
    .from(aiProviders)
    .where(eq(aiProviders.id, providerId))
    .limit(1);

  if (!provider) return null;

  const query: UsageQuery = { organizationId, providerId, ...window };

  const [totals, series, keyRows, collection, keyMeta] = await Promise.all([
    summarizeUsage(query),
    usageTimeSeries(query, 'day'),
    usageBreakdown(query, 'apiKey'),
    collectionState(organizationId, { providerId }, window.from),
    db
      .select({
        id: apiKeys.id,
        environment: apiKeys.environment,
        projectName: projects.name,
      })
      .from(apiKeys)
      .innerJoin(projects, eq(projects.id, apiKeys.projectId))
      .where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.providerId, providerId))),
  ]);

  const metaById = new Map(keyMeta.map((row) => [row.id, row]));

  return {
    provider,
    totals,
    series,
    collection,
    assessment: assessFrom(provider.name, collection, totals),
    keys: keyRows.map((row) => ({
      ...row,
      environment: metaById.get(row.id)?.environment ?? 'production',
      projectName: metaById.get(row.id)?.projectName ?? '',
    })),
  };
}

export interface KeyAnalytics extends AnalyticsView {
  /** Usage split by the interval the provider reported, newest first. */
  intervals: UsageSeriesPoint[];
}

export async function loadKeyAnalytics(
  organizationId: string,
  apiKeyId: string,
  providerName: string,
  window: { from: Date; to: Date }
): Promise<KeyAnalytics> {
  const query: UsageQuery = { organizationId, apiKeyId, ...window };

  const [totals, series, collection] = await Promise.all([
    summarizeUsage(query),
    usageTimeSeries(query, 'day'),
    collectionState(organizationId, { apiKeyId }, window.from),
  ]);

  return {
    totals,
    series,
    collection,
    assessment: assessFrom(providerName, collection, totals),
    intervals: [...series].reverse(),
  };
}

export interface ProjectAnalytics {
  totals: UsageTotals;
  series: UsageSeriesPoint[];
  byProvider: UsageBreakdownRow[];
  byKey: (UsageBreakdownRow & { providerName: string; environment: string })[];
}

export async function loadProjectAnalytics(
  organizationId: string,
  projectId: string,
  window: { from: Date; to: Date }
): Promise<ProjectAnalytics> {
  const db = getDb();
  const query: UsageQuery = { organizationId, projectId, ...window };

  const [totals, series, byProvider, byKey, keyMeta] = await Promise.all([
    summarizeUsage(query),
    usageTimeSeries(query, 'day'),
    usageBreakdown(query, 'provider'),
    usageBreakdown(query, 'apiKey'),
    db
      .select({
        id: apiKeys.id,
        environment: apiKeys.environment,
        providerName: aiProviders.name,
      })
      .from(apiKeys)
      .innerJoin(aiProviders, eq(aiProviders.id, apiKeys.providerId))
      .where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.projectId, projectId))),
  ]);

  const metaById = new Map(keyMeta.map((row) => [row.id, row]));

  return {
    totals,
    series,
    byProvider,
    byKey: byKey.map((row) => ({
      ...row,
      providerName: metaById.get(row.id)?.providerName ?? '',
      environment: metaById.get(row.id)?.environment ?? 'production',
    })),
  };
}

/**
 * Which project is consuming the most AI resources.
 *
 * The build plan asks the project view to answer this, so it is computed once
 * here and ranked by cost where cost exists, falling back to tokens. Ranking
 * silently by whichever number happens to be present would put a project with
 * a known cost below one with only a token count.
 */
export async function rankProjectsByConsumption(
  organizationId: string,
  window: { from: Date; to: Date }
): Promise<{
  rows: UsageBreakdownRow[];
  /** What the ranking is actually sorted by, so the page can say so. */
  basis: 'cost' | 'tokens' | 'requests' | 'none';
}> {
  const rows = await usageBreakdown({ organizationId, ...window }, 'project');

  if (rows.some((row) => row.estimatedCost !== null)) return { rows, basis: 'cost' };

  if (rows.some((row) => row.totalTokens !== null)) {
    return {
      rows: [...rows].sort((a, b) => (b.totalTokens ?? 0) - (a.totalTokens ?? 0)),
      basis: 'tokens',
    };
  }

  if (rows.some((row) => row.requests !== null)) {
    return {
      rows: [...rows].sort((a, b) => (b.requests ?? 0) - (a.requests ?? 0)),
      basis: 'requests',
    };
  }

  return { rows, basis: 'none' };
}
