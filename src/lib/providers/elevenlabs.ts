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
 * ElevenLabs adapter.
 *
 * Docs: https://elevenlabs.io/docs/api-reference
 *
 * `GET /v1/user` returns the account's subscription, including
 * `character_count`, `character_limit` and `next_character_count_reset_unix`.
 * That is a genuine **quota**, which makes ElevenLabs one of the few providers
 * where "this key is approaching its limit" can be answered directly -- the
 * central question the dashboard exists to answer.
 *
 * It is deliberately reported through `fetchLimits` rather than `fetchUsage`.
 * `character_count` is a monotonic counter for the current billing period, not
 * consumption over an arbitrary window, so returning it as windowed usage would
 * be wrong: two collections a minute apart would each report the whole period's
 * total. Deriving per-interval usage by differencing the counter is Phase 5/6
 * work, and needs stored history to do correctly.
 */

const BASE_URL = 'https://api.elevenlabs.io/v1';
const USER_URL = `${BASE_URL}/user`;

const NO_WINDOWED_USAGE =
  'ElevenLabs reports a cumulative character counter for the current billing period, not usage over an arbitrary window. Read it as a quota via limits; per-interval consumption must be derived by differencing samples over time.';

/** ElevenLabs authenticates with its own header rather than a bearer token. */
function authHeaders(credential: ProviderCredential): Record<string, string> {
  return { 'xi-api-key': credential.apiKey };
}

interface ElevenLabsSubscription {
  character_count?: number;
  character_limit?: number;
  next_character_count_reset_unix?: number;
  tier?: string;
  status?: string;
}

interface ElevenLabsUser {
  subscription?: ElevenLabsSubscription;
  user_id?: string;
}

function readUser(json: unknown): ElevenLabsUser | undefined {
  return typeof json === 'object' && json !== null ? (json as ElevenLabsUser) : undefined;
}

function readLimits(json: unknown, rateLimited: boolean): NormalizedLimits {
  const subscription = readUser(json)?.subscription;

  if (!subscription) {
    return {
      ...noLimits('provider_error', 'Response did not include a subscription object'),
      rateLimited,
    };
  }

  const used = subscription.character_count;
  const limit = subscription.character_limit;
  const resetUnix = subscription.next_character_count_reset_unix;

  return {
    // Request- and token-based limits are not concepts here.
    requestsLimit: unsupported('ElevenLabs meters characters, not requests'),
    requestsRemaining: unsupported('ElevenLabs meters characters, not requests'),
    tokensLimit: unsupported('ElevenLabs meters characters, not tokens'),
    tokensRemaining: unsupported('ElevenLabs meters characters, not tokens'),
    quotaUsed: typeof used === 'number' ? available(used) : unsupported('Not returned'),
    quotaLimit: typeof limit === 'number' ? available(limit) : unsupported('Not returned'),
    quotaUnit: available('characters'),
    balance: unsupported('ElevenLabs meters a character quota, not a prepaid balance'),
    resetsAt:
      typeof resetUnix === 'number'
        ? available(new Date(resetUnix * 1000))
        : unsupported('Not returned'),
    rateLimited,
  };
}

const probe: ProbeConfig = {
  url: USER_URL,
  headers: authHeaders,
  // The probe response already carries the quota, so no second call is needed.
  readLimits: (result) => readLimits(result.json, false),
  discover: (json) => {
    const userId = readUser(json)?.user_id;
    return userId ? { providerProjectId: userId } : {};
  },
};

export const elevenlabsAdapter: AIProviderAdapter = {
  type: 'elevenlabs',
  displayName: 'ElevenLabs',
  category: 'speech',

  capabilities: {
    usage: 'none',
    cost: 'none',
    limits: 'endpoint',
    meters: ['characters'],
    notes:
      'Exposes a real character quota for the current billing period (used, limit and reset time) on GET /v1/user, which supports approaching-limit alerts directly. No time-windowed usage or cost endpoint.',
  },

  async validateCredentials(credential) {
    return probeCredential(probe, credential);
  },

  async fetchHealth(credential) {
    return probeHealth(probe, credential);
  },

  async fetchLimits(credential): Promise<NormalizedLimits> {
    const result = await providerFetch({ url: USER_URL, headers: authHeaders(credential) });

    if (!result.ok) {
      return {
        ...noLimits('provider_error', result.detail),
        rateLimited: result.failure === 'rate_limited',
      };
    }

    return readLimits(result.json, false);
  },

  async fetchUsage(): Promise<UsageResult> {
    return { supported: false, reason: 'unsupported', detail: NO_WINDOWED_USAGE };
  },

  normalizeMetrics(): readonly NormalizedUsage[] {
    return [];
  },
};
