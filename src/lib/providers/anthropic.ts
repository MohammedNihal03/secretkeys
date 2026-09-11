import { headerInt, providerFetch, resetAtFromHeader } from './http';
import { probeCredential, probeHealth, type ProbeConfig } from './probe';
import {
  available,
  noLimits,
  unsupported,
  type AIProviderAdapter,
  type Metric,
  type NormalizedLimits,
  type NormalizedUsage,
  type ProviderCredential,
  type UsageRequest,
  type UsageResult,
  type UsageWindow,
} from './types';

/**
 * Anthropic adapter.
 *
 * Docs: https://platform.claude.com/docs/en/api
 *
 * Like OpenAI, usage and cost live behind an **Admin API key**
 * (`sk-ant-admin...`) on `/v1/organizations/usage_report/messages` and
 * `/v1/organizations/cost_report`, and are reported for the organization with
 * optional grouping by `api_key_id`.
 *
 * Anthropic splits input tokens three ways -- uncached, cache reads and cache
 * writes -- which are priced differently. The normalized `inputTokens` is the
 * sum, and the breakdown is preserved in `providerRaw` so later phases can
 * reason about cache efficiency without re-collecting.
 */

const BASE_URL = 'https://api.anthropic.com/v1';
const PROBE_URL = `${BASE_URL}/models`;
const USAGE_URL = `${BASE_URL}/organizations/usage_report/messages`;
const COST_URL = `${BASE_URL}/organizations/cost_report`;

/**
 * Required on every request. Pinned rather than tracking "latest" so a new
 * API version cannot silently change response shapes under us.
 */
const API_VERSION = '2023-06-01';

const ADMIN_KEY_PREFIX = 'sk-ant-admin';

const ADMIN_REQUIRED_DETAIL =
  'Anthropic reports usage and cost only on the organization endpoints, which require an Admin API key (sk-ant-admin...) rather than a standard API key.';

function authHeaders(credential: ProviderCredential): Record<string, string> {
  return {
    'x-api-key': credential.apiKey,
    'anthropic-version': API_VERSION,
  };
}

/**
 * Anthropic's rate-limit headers use its own prefix and report the most
 * restrictive limit currently in effect, which may be a workspace limit rather
 * than an organization one.
 */
function readAnthropicLimits(headers: Headers, rateLimited: boolean): NormalizedLimits {
  const NOT_RETURNED = 'Provider did not return this header';

  const count = (name: string): Metric<number> => {
    const value = headerInt(headers, name);
    return value === undefined ? unsupported(NOT_RETURNED) : available(value);
  };

  const reset =
    resetAtFromHeader(headers, 'anthropic-ratelimit-tokens-reset') ??
    resetAtFromHeader(headers, 'anthropic-ratelimit-requests-reset');

  return {
    requestsLimit: count('anthropic-ratelimit-requests-limit'),
    requestsRemaining: count('anthropic-ratelimit-requests-remaining'),
    tokensLimit: count('anthropic-ratelimit-tokens-limit'),
    tokensRemaining: count('anthropic-ratelimit-tokens-remaining'),
    quotaUsed: unsupported('Anthropic does not expose a billing-period quota'),
    quotaLimit: unsupported('Anthropic does not expose a billing-period quota'),
    quotaUnit: unsupported('Anthropic does not expose a billing-period quota'),
    balance: unsupported('Anthropic does not expose a prepaid balance via the API'),
    resetsAt: reset ? available(reset) : unsupported(NOT_RETURNED),
    rateLimited,
  };
}

const probe: ProbeConfig = {
  url: PROBE_URL,
  headers: authHeaders,
  readLimits: (result) => readAnthropicLimits(result.headers, false),
};

interface AnthropicCacheCreation {
  ephemeral_1h_input_tokens?: number;
  ephemeral_5m_input_tokens?: number;
}

interface AnthropicUsageRow {
  uncached_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** Newer nested shape. */
  cache_creation?: AnthropicCacheCreation;
  /** Older flat shape; both are tolerated. */
  cache_creation_input_tokens?: number;
  output_tokens?: number;
  api_key_id?: string | null;
  workspace_id?: string | null;
  model?: string | null;
  service_tier?: string | null;
}

interface AnthropicBucket {
  starting_at?: string;
  ending_at?: string;
  results?: AnthropicUsageRow[];
}

interface AnthropicCostRow {
  /** Reported as a decimal string in some responses and a number in others. */
  amount?: string | number;
  currency?: string;
  workspace_id?: string | null;
  description?: string | null;
}

interface AnthropicCostBucket {
  starting_at?: string;
  ending_at?: string;
  results?: AnthropicCostRow[];
}

function readBuckets<T>(payload: unknown): T[] {
  if (typeof payload !== 'object' || payload === null) return [];

  const data = (payload as { data?: unknown }).data;
  return Array.isArray(data) ? (data as T[]) : [];
}

function parseDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

/** Total cache-write tokens across both the nested and flat shapes. */
function cacheCreationTokens(row: AnthropicUsageRow): number {
  if (typeof row.cache_creation_input_tokens === 'number') {
    return row.cache_creation_input_tokens;
  }

  const creation = row.cache_creation;
  if (!creation) return 0;

  return (creation.ephemeral_1h_input_tokens ?? 0) + (creation.ephemeral_5m_input_tokens ?? 0);
}

export const anthropicAdapter: AIProviderAdapter = {
  type: 'anthropic',
  displayName: 'Anthropic',
  category: 'llm',

  capabilities: {
    usage: 'organization_admin',
    cost: 'organization_admin',
    limits: 'response_headers',
    meters: ['requests', 'tokens'],
    notes:
      'Usage and cost require an organization Admin API key (sk-ant-admin...) and are reported for the whole organization, groupable by Anthropic key id. Input tokens are split into uncached, cache-read and cache-write.',
  },

  async validateCredentials(credential) {
    return probeCredential(probe, credential);
  },

  async fetchHealth(credential) {
    return probeHealth(probe, credential);
  },

  async fetchLimits(credential): Promise<NormalizedLimits> {
    const result = await providerFetch({ url: PROBE_URL, headers: authHeaders(credential) });

    if (!result.ok) return noLimits('provider_error', result.detail);

    return readAnthropicLimits(result.headers, false);
  },

  async fetchUsage(request: UsageRequest): Promise<UsageResult> {
    if (!request.credential.apiKey.startsWith(ADMIN_KEY_PREFIX)) {
      return {
        supported: false,
        reason: 'requires_admin_credential',
        detail: ADMIN_REQUIRED_DETAIL,
      };
    }

    const params = new URLSearchParams({
      starting_at: request.window.start.toISOString(),
      ending_at: request.window.end.toISOString(),
      bucket_width: '1d',
      'group_by[]': 'api_key_id',
      limit: '31',
    });

    const usage = await providerFetch({
      url: `${USAGE_URL}?${params.toString()}`,
      headers: authHeaders(request.credential),
    });

    if (!usage.ok) {
      return { supported: false, reason: 'provider_error', detail: usage.detail };
    }

    const entries = this.normalizeMetrics(usage.json, request.window);

    const costParams = new URLSearchParams({
      starting_at: request.window.start.toISOString(),
      ending_at: request.window.end.toISOString(),
      limit: '31',
    });

    const cost = await providerFetch({
      url: `${COST_URL}?${costParams.toString()}`,
      headers: authHeaders(request.credential),
    });

    if (!cost.ok) {
      return {
        supported: true,
        entries: entries.map((entry) => ({
          ...entry,
          estimatedCostUsd: {
            available: false as const,
            reason: 'provider_error' as const,
            detail: cost.detail,
          },
        })),
      };
    }

    return { supported: true, entries: attachCosts(entries, cost.json) };
  },

  normalizeMetrics(payload: unknown, window: UsageWindow): readonly NormalizedUsage[] {
    const buckets = readBuckets<AnthropicBucket>(payload);
    const entries: NormalizedUsage[] = [];

    for (const bucket of buckets) {
      const windowStart = parseDate(bucket.starting_at, window.start);
      const windowEnd = parseDate(bucket.ending_at, window.end);

      for (const row of bucket.results ?? []) {
        const uncached = row.uncached_input_tokens ?? 0;
        const cacheRead = row.cache_read_input_tokens ?? 0;
        const cacheWrite = cacheCreationTokens(row);
        const outputTokens = row.output_tokens ?? 0;

        /**
         * All three input categories are real input tokens and all are billed,
         * at different rates. Summing them is the honest normalization; the
         * split is kept below so cache efficiency stays analysable.
         */
        const inputTokens = uncached + cacheRead + cacheWrite;

        entries.push({
          windowStart,
          windowEnd,
          // Anthropic's usage report is token-based and carries no request count.
          requests: unsupported('Anthropic usage report does not include a request count'),
          successfulRequests: unsupported('Anthropic usage report does not split by outcome'),
          failedRequests: unsupported('Anthropic usage report does not split by outcome'),
          inputTokens: available(inputTokens),
          outputTokens: available(outputTokens),
          totalTokens: available(inputTokens + outputTokens),
          characters: unsupported('Not metered by Anthropic'),
          audioSeconds: unsupported('Not metered by Anthropic'),
          estimatedCostUsd: unsupported('Fetched separately from /organizations/cost_report'),
          ...(row.api_key_id ? { providerKeyId: row.api_key_id } : {}),
          providerRaw: {
            uncachedInputTokens: uncached,
            cacheReadInputTokens: cacheRead,
            cacheCreationInputTokens: cacheWrite,
            model: row.model ?? null,
            workspaceId: row.workspace_id ?? null,
            serviceTier: row.service_tier ?? null,
          },
        });
      }
    }

    return entries;
  },
};

/**
 * Attaches daily cost to usage entries.
 *
 * The cost report groups by workspace and description, never by key, so a day's
 * cost can only be attributed when exactly one key was active that day.
 * Splitting it proportionally would produce a number the provider never
 * reported.
 */
function attachCosts(
  entries: readonly NormalizedUsage[],
  payload: unknown
): readonly NormalizedUsage[] {
  const buckets = readBuckets<AnthropicCostBucket>(payload);
  const costByDay = new Map<string, number>();

  for (const bucket of buckets) {
    const day = parseDate(bucket.starting_at, new Date(0)).toISOString().slice(0, 10);

    const total = (bucket.results ?? []).reduce(
      (sum, row) => {
        const amount = typeof row.amount === 'string' ? Number(row.amount) : row.amount;
        return sum + (Number.isFinite(amount) ? (amount as number) : 0);
      },
      costByDay.get(day) ?? 0
    );

    costByDay.set(day, total);
  }

  const keysPerDay = new Map<string, Set<string>>();
  for (const entry of entries) {
    const day = entry.windowStart.toISOString().slice(0, 10);
    const keys = keysPerDay.get(day) ?? new Set<string>();
    keys.add(entry.providerKeyId ?? 'unattributed');
    keysPerDay.set(day, keys);
  }

  return entries.map((entry) => {
    const day = entry.windowStart.toISOString().slice(0, 10);
    const cost = costByDay.get(day);

    if (cost === undefined) {
      return { ...entry, estimatedCostUsd: unsupported('No cost reported for this day') };
    }

    if ((keysPerDay.get(day)?.size ?? 0) > 1) {
      return {
        ...entry,
        estimatedCostUsd: unsupported(
          'Anthropic reports cost per day for the whole organization, not per key, so it cannot be attributed when several keys were used'
        ),
      };
    }

    return { ...entry, estimatedCostUsd: available(cost) };
  });
}
