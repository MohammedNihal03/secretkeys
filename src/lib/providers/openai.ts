import { headerInt, providerFetch, readOpenAIStyleLimits } from './http';
import { limitsFromProbeHeaders, probeCredential, probeHealth, type ProbeConfig } from './probe';
import {
  available,
  noLimits,
  requiresAdminCredential,
  unsupported,
  type AIProviderAdapter,
  type CredentialValidation,
  type NormalizedLimits,
  type NormalizedUsage,
  type ProviderCredential,
  type ProviderHealth,
  type UsageRequest,
  type UsageResult,
  type UsageWindow,
} from './types';

/**
 * OpenAI adapter.
 *
 * Docs: https://platform.openai.com/docs/api-reference
 *
 * The important structural fact: **usage and cost are not readable with a
 * project API key**. They live on the organization endpoints
 * `/v1/organization/usage/completions` and `/v1/organization/costs`, which
 * require an *Admin* API key created by an organization owner.
 *
 * Those endpoints return the whole organization's usage, optionally grouped by
 * `api_key_id`. So per-project attribution works the other way around from
 * what one might expect: one admin-key call per organization, grouped by key,
 * then each returned `api_key_id` mapped back to one of our registered
 * credentials via `api_keys.provider_key_id`.
 */

const BASE_URL = 'https://api.openai.com/v1';

/** Free, read-only, and unaffected by billing state -- safe as a probe. */
const PROBE_URL = `${BASE_URL}/models`;

const USAGE_URL = `${BASE_URL}/organization/usage/completions`;
const COSTS_URL = `${BASE_URL}/organization/costs`;

/**
 * An admin key is the only credential these endpoints accept, and OpenAI
 * prefixes them distinctly. Checking the prefix lets the adapter explain the
 * problem instead of surfacing a bare 401.
 */
const ADMIN_KEY_PREFIX = 'sk-admin-';

const ADMIN_REQUIRED_DETAIL =
  'OpenAI reports usage and cost only on the organization endpoints, which require an Admin API key (sk-admin-...) rather than a project key.';

function authHeaders(credential: ProviderCredential): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.apiKey}`,
    // Scopes the call to a provider-side project when one is recorded.
    ...(credential.providerProjectId ? { 'OpenAI-Project': credential.providerProjectId } : {}),
  };
}

const probe: ProbeConfig = {
  url: PROBE_URL,
  headers: authHeaders,
  readLimits: (result) => ({
    ...noLimits('unsupported', 'Not reported on this endpoint'),
    ...readOpenAIStyleLimits(result.headers),
    rateLimited: false,
  }),
};

/** One time bucket of the completions usage response. */
interface OpenAIUsageBucket {
  start_time?: number;
  end_time?: number;
  results?: {
    input_tokens?: number;
    output_tokens?: number;
    input_cached_tokens?: number;
    num_model_requests?: number;
    api_key_id?: string | null;
    project_id?: string | null;
    model?: string | null;
  }[];
}

/** Buckets from `/organization/costs`, keyed by day. */
interface OpenAICostBucket {
  start_time?: number;
  end_time?: number;
  results?: {
    amount?: { value?: number; currency?: string };
    project_id?: string | null;
    line_item?: string | null;
  }[];
}

function toDate(epochSeconds: number | undefined, fallback: Date): Date {
  return typeof epochSeconds === 'number' ? new Date(epochSeconds * 1000) : fallback;
}

export const openaiAdapter: AIProviderAdapter = {
  type: 'openai',
  displayName: 'OpenAI',
  category: 'llm',

  capabilities: {
    usage: 'organization_admin',
    cost: 'organization_admin',
    limits: 'response_headers',
    meters: ['requests', 'tokens'],
    notes:
      'Usage and cost require an organization Admin API key and are reported for the whole organization, grouped by OpenAI key id. Rate limits appear only as response headers.',
  },

  async validateCredentials(credential): Promise<CredentialValidation> {
    return probeCredential(probe, credential);
  },

  async fetchHealth(credential): Promise<ProviderHealth> {
    return probeHealth(probe, credential);
  },

  async fetchLimits(credential): Promise<NormalizedLimits> {
    return limitsFromProbeHeaders(
      probe,
      credential,
      'OpenAI exposes rate limits only as response headers on inference calls.'
    );
  },

  async fetchUsage(request: UsageRequest): Promise<UsageResult> {
    if (!request.credential.apiKey.startsWith(ADMIN_KEY_PREFIX)) {
      /**
       * Refused before calling, rather than letting OpenAI return 401. The
       * distinction matters: an ordinary key is not *invalid*, it simply
       * cannot read organization usage, and an administrator needs to be told
       * which credential to supply.
       */
      return {
        supported: false,
        reason: 'requires_admin_credential',
        detail: ADMIN_REQUIRED_DETAIL,
      };
    }

    const params = new URLSearchParams({
      start_time: String(Math.floor(request.window.start.getTime() / 1000)),
      end_time: String(Math.floor(request.window.end.getTime() / 1000)),
      bucket_width: '1d',
      // Attribution depends entirely on this grouping.
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

    /**
     * Cost comes from a separate endpoint. OpenAI documents that usage and
     * cost do not reconcile exactly, and that costs are authoritative for
     * money, so the two are fetched separately rather than cost being derived
     * from token counts and a price list.
     */
    const costParams = new URLSearchParams({
      start_time: String(Math.floor(request.window.start.getTime() / 1000)),
      end_time: String(Math.floor(request.window.end.getTime() / 1000)),
      limit: '31',
    });

    const costs = await providerFetch({
      url: `${COSTS_URL}?${costParams.toString()}`,
      headers: authHeaders(request.credential),
    });

    if (!costs.ok) {
      // Usage is still valid; only cost is missing.
      return {
        supported: true,
        entries: entries.map((entry) => ({
          ...entry,
          estimatedCostUsd: {
            available: false as const,
            reason: 'provider_error' as const,
            detail: costs.detail,
          },
        })),
      };
    }

    return { supported: true, entries: mergeCosts(entries, costs.json) };
  },

  normalizeMetrics(payload: unknown, window: UsageWindow): readonly NormalizedUsage[] {
    const buckets = readBuckets<OpenAIUsageBucket>(payload);
    const entries: NormalizedUsage[] = [];

    for (const bucket of buckets) {
      const windowStart = toDate(bucket.start_time, window.start);
      const windowEnd = toDate(bucket.end_time, window.end);

      for (const row of bucket.results ?? []) {
        const inputTokens = row.input_tokens ?? 0;
        const outputTokens = row.output_tokens ?? 0;
        const requests = row.num_model_requests ?? 0;

        entries.push({
          windowStart,
          windowEnd,
          requests: available(requests),
          /**
           * OpenAI's usage endpoint counts model requests without splitting
           * success from failure, so these are unavailable rather than being
           * guessed as "all successful" -- which would hide an error spike.
           */
          successfulRequests: unsupported('OpenAI usage does not split requests by outcome'),
          failedRequests: unsupported('OpenAI usage does not split requests by outcome'),
          inputTokens: available(inputTokens),
          outputTokens: available(outputTokens),
          totalTokens: available(inputTokens + outputTokens),
          characters: unsupported('Not metered by OpenAI'),
          audioSeconds: unsupported('Not metered on the completions usage endpoint'),
          estimatedCostUsd: requiresAdminCredential('Fetched separately from /organization/costs'),
          ...(row.api_key_id ? { providerKeyId: row.api_key_id } : {}),
          providerRaw: {
            model: row.model ?? null,
            projectId: row.project_id ?? null,
            inputCachedTokens: row.input_cached_tokens ?? null,
          },
        });
      }
    }

    return entries;
  },
};

/** Extracts the `data[]` array of buckets from a paginated OpenAI response. */
function readBuckets<T>(payload: unknown): T[] {
  if (typeof payload !== 'object' || payload === null) return [];

  const data = (payload as { data?: unknown }).data;
  return Array.isArray(data) ? (data as T[]) : [];
}

/**
 * Attaches costs to usage entries by day.
 *
 * The cost endpoint does not group by key, so a day's cost cannot be split
 * across the keys that produced it. Rather than apportion it -- which would
 * invent a number -- the cost is attached only when a day has exactly one
 * key's usage, and left unavailable otherwise.
 */
function mergeCosts(
  entries: readonly NormalizedUsage[],
  costPayload: unknown
): readonly NormalizedUsage[] {
  const buckets = readBuckets<OpenAICostBucket>(costPayload);

  const costByDay = new Map<string, number>();
  for (const bucket of buckets) {
    if (typeof bucket.start_time !== 'number') continue;

    const day = new Date(bucket.start_time * 1000).toISOString().slice(0, 10);
    const total = (bucket.results ?? []).reduce(
      (sum, row) => sum + (row.amount?.value ?? 0),
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
    const keyCount = keysPerDay.get(day)?.size ?? 0;

    if (cost === undefined) {
      return {
        ...entry,
        estimatedCostUsd: unsupported('No cost reported for this day'),
      };
    }

    if (keyCount > 1) {
      return {
        ...entry,
        estimatedCostUsd: unsupported(
          'OpenAI reports cost per day for the whole organization, not per key, so it cannot be attributed when several keys were used'
        ),
      };
    }

    return { ...entry, estimatedCostUsd: available(cost) };
  });
}

/** Exposed for tests: reading the rate-limit headers OpenAI returns. */
export function readOpenAIRateLimitHeaders(headers: Headers): {
  requestsRemaining: number | undefined;
  tokensRemaining: number | undefined;
} {
  return {
    requestsRemaining: headerInt(headers, 'x-ratelimit-remaining-requests'),
    tokensRemaining: headerInt(headers, 'x-ratelimit-remaining-tokens'),
  };
}
