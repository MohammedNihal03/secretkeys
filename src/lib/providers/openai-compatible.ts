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
 * Groq and Qwen both serve `GET {base}/models` with `Authorization: Bearer` and
 * return the `x-ratelimit-*` header family, so validation, health and limits
 * are identical. Neither exposes a usage or cost endpoint -- per-request token
 * counts come back in the inference response body, which is Phase 5 territory,
 * not something that can be polled here.
 *
 * Note that matching header *names* does not mean matching semantics: Groq
 * documents `x-ratelimit-limit-requests` as requests per *day* whereas OpenAI
 * scopes it per minute. Values are reported as-is.
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
    readLimits: (result) => readLimits(result.headers, false),
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
      const result = await providerFetch({ url: probeUrl, headers: authHeaders(credential) });

      if (!result.ok) {
        // A 429 is itself the most important limit signal, so record it.
        return result.failure === 'rate_limited'
          ? { ...noLimits('provider_error', result.detail), rateLimited: true }
          : noLimits('provider_error', result.detail);
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
