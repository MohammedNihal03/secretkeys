import { providerFetch } from './http';
import { probeCredential, probeHealth, type ProbeConfig } from './probe';
import {
  available,
  noLimits,
  unsupported,
  type AIProviderAdapter,
  type CurrencyAmount,
  type NormalizedLimits,
  type NormalizedUsage,
  type ProviderCredential,
  type ProviderHealth,
  type UsageResult,
} from './types';

/**
 * DeepSeek adapter.
 *
 * Docs: https://api-docs.deepseek.com/api/get-user-balance/
 *
 * DeepSeek is prepaid. `GET /user/balance` returns the remaining balance per
 * currency and `is_available` -- whether that balance is sufficient for API
 * calls. There is no usage or cost endpoint, and no quota: a balance does not
 * have a limit, it simply runs out.
 *
 * `is_available` is the valuable signal here. When it turns false, every call
 * starts failing, so health reports that as unhealthy -- catching an exhausted
 * account before users do, which is the point of the dashboard.
 */

const BASE_URL = 'https://api.deepseek.com';
const MODELS_URL = `${BASE_URL}/models`;
const BALANCE_URL = `${BASE_URL}/user/balance`;

const PREPAID = 'DeepSeek is prepaid: there is a remaining balance, not a usage limit';
const NOT_REPORTED = 'Not reported by the balance endpoint';

function authHeaders(credential: ProviderCredential): Record<string, string> {
  return { Authorization: `Bearer ${credential.apiKey}` };
}

interface DeepSeekBalanceInfo {
  currency?: string;
  /** Decimal strings in the documented response; numbers are tolerated. */
  total_balance?: string | number;
  granted_balance?: string | number;
  topped_up_balance?: string | number;
}

interface DeepSeekBalance {
  is_available?: boolean;
  balance_infos?: DeepSeekBalanceInfo[];
}

function toAmount(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

function readBalanceBody(json: unknown): DeepSeekBalance | undefined {
  return typeof json === 'object' && json !== null ? (json as DeepSeekBalance) : undefined;
}

/** Normalizes the `/user/balance` response. Exported for tests. */
export function readDeepSeekLimits(json: unknown): NormalizedLimits {
  const body = readBalanceBody(json);

  if (!body) {
    return noLimits('provider_error', 'Unexpected balance response');
  }

  const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];

  // An entry with an unparseable amount or no currency is dropped, never zeroed.
  const balances: CurrencyAmount[] = infos.flatMap((info) => {
    const amount = toAmount(info.total_balance);
    return amount !== null && typeof info.currency === 'string'
      ? [{ amount, currency: info.currency }]
      : [];
  });

  return {
    requestsLimit: unsupported(NOT_REPORTED),
    requestsRemaining: unsupported(NOT_REPORTED),
    tokensLimit: unsupported(NOT_REPORTED),
    tokensRemaining: unsupported(NOT_REPORTED),
    quotaUsed: unsupported(PREPAID),
    quotaLimit: unsupported(PREPAID),
    quotaUnit: unsupported(PREPAID),
    balance: balances.length > 0 ? available(balances) : unsupported('No balance was returned'),
    resetsAt: unsupported(PREPAID),
    rateLimited: false,
    providerRaw: {
      isAvailable: body.is_available ?? null,
      balanceInfos: infos.map((info) => ({
        currency: info.currency ?? null,
        total: toAmount(info.total_balance),
        granted: toAmount(info.granted_balance),
        toppedUp: toAmount(info.topped_up_balance),
      })),
    },
  };
}

const probe: ProbeConfig = {
  url: MODELS_URL,
  headers: authHeaders,
};

export const deepseekAdapter: AIProviderAdapter = {
  type: 'deepseek',
  displayName: 'DeepSeek',
  category: 'llm',

  capabilities: {
    usage: 'none',
    cost: 'none',
    limits: 'endpoint',
    meters: ['requests', 'tokens'],
    notes:
      'GET /user/balance reports the prepaid balance per currency and whether it is sufficient for API calls, so an exhausted account shows as unhealthy before calls start failing. No usage or cost endpoint.',
  },

  async validateCredentials(credential) {
    return probeCredential(probe, credential);
  },

  async fetchHealth(credential): Promise<ProviderHealth> {
    const health = await probeHealth(probe, credential);

    // Only worth checking the balance when the service itself is answering.
    if (!health.reachable) return health;

    const balance = await providerFetch({ url: BALANCE_URL, headers: authHeaders(credential) });

    // A failed balance check tells us nothing new about reachability.
    if (!balance.ok) return health;

    if (readBalanceBody(balance.json)?.is_available === false) {
      return {
        ...health,
        status: 'unhealthy',
        error:
          'Insufficient balance: DeepSeek will reject API calls until the account is topped up.',
      };
    }

    return health;
  },

  async fetchLimits(credential): Promise<NormalizedLimits> {
    const result = await providerFetch({ url: BALANCE_URL, headers: authHeaders(credential) });

    if (!result.ok) {
      return {
        ...noLimits('provider_error', result.detail),
        rateLimited: result.failure === 'rate_limited',
      };
    }

    return readDeepSeekLimits(result.json);
  },

  async fetchUsage(): Promise<UsageResult> {
    return {
      supported: false,
      reason: 'unsupported',
      detail:
        'DeepSeek exposes no usage or cost endpoint; the API reports only the remaining balance. Usage and spend are visible in the DeepSeek platform console.',
    };
  },

  normalizeMetrics(): readonly NormalizedUsage[] {
    return [];
  },
};
