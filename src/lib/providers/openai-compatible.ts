import { providerFetch, readOpenAIStyleLimits } from './http';
import { probeCredential, probeHealth, type ProbeConfig } from './probe';
import {
  noLimits,
  unsupported,
  type AIProviderAdapter,
  type AiProviderType,
  type NormalizedLimits,
  type NormalizedUsage,
  type ProviderCapabilities,
  type ProviderCredential,
  type UsageResult,
} from './types';

/**
 * Adapter factory for providers that expose an OpenAI-compatible API.
 *
 * Groq, Qwen and Mistral all serve `GET {base}/models` with
 * `Authorization: Bearer`, so validation and health are identical. None exposes
 * a usage or cost endpoint -- per-request token counts come back in inference
 * responses, which is Phase 5 territory, not something that can be polled.
 *
 * Rate-limit headers are the part that differs, and matching header *names* do
 * not imply matching semantics: Groq documents `x-ratelimit-limit-requests` as
 * requests per *day* whereas OpenAI scopes it per minute. Values are reported
 * as-is, and only for a provider whose headers have been verified.
 */

export interface OpenAICompatibleConfig {
  readonly type: AiProviderType;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly capabilities: ProviderCapabilities;
  /** Why usage is unavailable, phrased for this specific provider. */
  readonly noUsageDetail: string;
}

export function createOpenAICompatibleAdapter(config: OpenAICompatibleConfig): AIProviderAdapter {
  const probeUrl = `${config.baseUrl}/models`;

  /**
   * Headers are read only when the provider declares
   * `limits: 'response_headers'`. Deriving this from the declared capability,
   * rather than a separate flag, means the two cannot disagree -- which is the
   * bug this replaced: Qwen declared no limits, yet its headers were read
   * anyway, so the capability matrix and the behaviour contradicted each other.
   */
  const readsHeaders = config.capabilities.limits === 'response_headers';

  const authHeaders = (credential: ProviderCredential): Record<string, string> => ({
    Authorization: `Bearer ${credential.apiKey}`,
  });

  const readLimits = (headers: Headers, rateLimited: boolean): NormalizedLimits => ({
    ...noLimits('unsupported', 'Not reported by this provider'),
    ...readOpenAIStyleLimits(headers),
    quotaUsed: unsupported('No billing-period quota endpoint'),
    quotaLimit: unsupported('No billing-period quota endpoint'),
    quotaUnit: unsupported('No billing-period quota endpoint'),
    rateLimited,
  });

  const probe: ProbeConfig = {
    url: probeUrl,
    headers: authHeaders,
    ...(readsHeaders ? { readLimits: (result) => readLimits(result.headers, false) } : {}),
  };

  return {
    type: config.type,
    displayName: config.displayName,
    category: 'llm',
    capabilities: config.capabilities,

    async validateCredentials(credential) {
      return probeCredential(probe, credential);
    },

    async fetchHealth(credential) {
      return probeHealth(probe, credential);
    },

    async fetchLimits(credential): Promise<NormalizedLimits> {
      /**
       * Called even for a provider that exposes no limit headers: a 429 is the
       * one limit signal every provider gives, and it is only observable by
       * making the request.
       */
      const result = await providerFetch({ url: probeUrl, headers: authHeaders(credential) });

      if (!result.ok) {
        return result.failure === 'rate_limited'
          ? { ...noLimits('provider_error', result.detail), rateLimited: true }
          : noLimits('provider_error', result.detail);
      }

      if (!readsHeaders) {
        return noLimits('unsupported', config.capabilities.notes);
      }

      return readLimits(result.headers, false);
    },

    async fetchUsage(): Promise<UsageResult> {
      return { supported: false, reason: 'unsupported', detail: config.noUsageDetail };
    },

    normalizeMetrics(): readonly NormalizedUsage[] {
      return [];
    },
  };
}
