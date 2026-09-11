import { providerFetch } from './http';
import { probeCredential, probeHealth, type ProbeConfig } from './probe';
import {
  available,
  noLimits,
  unsupported,
  type AIProviderAdapter,
  type NormalizedLimits,
  type NormalizedUsage,
  type ProviderCredential,
  type UsageResult,
} from './types';

/**
 * OpenRouter adapter.
 *
 * Docs: https://openrouter.ai/docs/api_reference/limits
 *
 * `GET /api/v1/key` describes the calling key itself: its credit limit, how
 * much of that limit remains, how the limit resets, and running spend totals
 * for the day, week and month. Credits are USD-denominated. That makes
 * OpenRouter one of the best providers for "is this key about to run out?" --
 * the answer comes straight from the project key, with no admin credential.
 *
 * Spend arrives as daily/weekly/monthly running totals rather than for an
 * arbitrary window, so, like ElevenLabs, it is surfaced through limits rather
 * than returned as windowed usage.
 */

const BASE_URL = 'https://openrouter.ai/api/v1';
const KEY_URL = `${BASE_URL}/key`;

function authHeaders(credential: ProviderCredential): Record<string, string> {
  return { Authorization: `Bearer ${credential.apiKey}` };
}

interface OpenRouterKeyData {
  label?: string;
  limit?: number | null;
  limit_remaining?: number | null;
  limit_reset?: string | null;
  include_byok_in_limit?: boolean;
  usage?: number;
  usage_daily?: number;
  usage_weekly?: number;
  usage_monthly?: number;
  byok_usage?: number;
  byok_usage_daily?: number;
  byok_usage_weekly?: number;
  byok_usage_monthly?: number;
  is_free_tier?: boolean;
}

function readKeyData(json: unknown): OpenRouterKeyData | undefined {
  if (typeof json !== 'object' || json === null) return undefined;

  const data = (json as { data?: unknown }).data;
  return typeof data === 'object' && data !== null ? (data as OpenRouterKeyData) : undefined;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Normalizes the `/key` response. Exported for tests. */
export function readOpenRouterLimits(json: unknown): NormalizedLimits {
  const data = readKeyData(json);

  if (!data) {
    return noLimits('provider_error', 'Response did not include a data object');
  }

  const NOT_REPORTED = 'Not reported by the OpenRouter key endpoint';
  const NO_LIMIT = 'No credit limit is set on this key';

  const limit = finiteOrNull(data.limit);
  const remaining = finiteOrNull(data.limit_remaining);

  return {
    requestsLimit: unsupported(NOT_REPORTED),
    requestsRemaining: unsupported(NOT_REPORTED),
    tokensLimit: unsupported(NOT_REPORTED),
    tokensRemaining: unsupported(NOT_REPORTED),

    quotaLimit: limit === null ? unsupported(NO_LIMIT) : available(limit),

    /**
     * Derived from the provider's own two figures rather than from the
     * `usage_*` totals. Which period counts and whether BYOK spend is included
     * both depend on the key's configuration; `limit - limit_remaining` has
     * already applied those rules, so it is the one figure that cannot be
     * subtly wrong.
     */
    quotaUsed:
      limit === null || remaining === null
        ? unsupported(NO_LIMIT)
        : available(Math.max(0, limit - remaining)),

    quotaUnit: available('usd'),
    balance: unsupported('Account balance is not included in the key endpoint'),

    // OpenRouter names the reset period but never gives the instant, so no
    // timestamp is invented from the period name.
    resetsAt: unsupported(
      data.limit_reset
        ? `Resets ${data.limit_reset}; OpenRouter does not return the exact reset time`
        : 'This limit does not reset'
    ),

    rateLimited: false,

    /**
     * `label` is deliberately excluded: OpenRouter labels commonly contain a
     * masked form of the key itself, and nothing here needs it.
     */
    providerRaw: {
      limitReset: data.limit_reset ?? null,
      includeByokInLimit: data.include_byok_in_limit ?? null,
      usageTotal: finiteOrNull(data.usage),
      usageDaily: finiteOrNull(data.usage_daily),
      usageWeekly: finiteOrNull(data.usage_weekly),
      usageMonthly: finiteOrNull(data.usage_monthly),
      byokUsageTotal: finiteOrNull(data.byok_usage),
      byokUsageDaily: finiteOrNull(data.byok_usage_daily),
      byokUsageWeekly: finiteOrNull(data.byok_usage_weekly),
      byokUsageMonthly: finiteOrNull(data.byok_usage_monthly),
      isFreeTier: data.is_free_tier ?? null,
    },
  };
}

const probe: ProbeConfig = {
  // Free, authenticated and read-only -- and it returns the limits too.
  url: KEY_URL,
  headers: authHeaders,
  readLimits: (result) => readOpenRouterLimits(result.json),
};

export const openrouterAdapter: AIProviderAdapter = {
  type: 'openrouter',
  displayName: 'OpenRouter',
  category: 'llm',

  capabilities: {
    usage: 'none',
    cost: 'per_key',
    limits: 'endpoint',
    meters: ['requests', 'tokens'],
    notes:
      'GET /api/v1/key reports the key’s USD credit limit, how much remains, how it resets, and running daily, weekly and monthly spend — readable with the project key itself. No token or request counts, and no exact reset time.',
  },

  async validateCredentials(credential) {
    return probeCredential(probe, credential);
  },

  async fetchHealth(credential) {
    return probeHealth(probe, credential);
  },

  async fetchLimits(credential): Promise<NormalizedLimits> {
    const result = await providerFetch({ url: KEY_URL, headers: authHeaders(credential) });

    if (!result.ok) {
      return {
        ...noLimits('provider_error', result.detail),
        rateLimited: result.failure === 'rate_limited',
      };
    }

    return readOpenRouterLimits(result.json);
  },

  async fetchUsage(): Promise<UsageResult> {
    return {
      supported: false,
      reason: 'unsupported',
      detail:
        'OpenRouter reports spend as daily, weekly and monthly running totals on the key endpoint, not for an arbitrary window, and no token or request counts. Spend is read through limits.',
    };
  },

  normalizeMetrics(): readonly NormalizedUsage[] {
    return [];
  },
};
