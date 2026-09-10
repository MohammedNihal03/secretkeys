import { probeCredential, probeHealth, type ProbeConfig } from './probe';
import {
  noLimits,
  type AIProviderAdapter,
  type NormalizedLimits,
  type NormalizedUsage,
  type ProviderCredential,
  type UsageResult,
} from './types';

/**
 * Google Gemini adapter (Gemini Developer API).
 *
 * Docs: https://ai.google.dev/api
 *
 * The Developer API exposes **no usage, cost or quota endpoint at all**. Model
 * discovery and inference are the whole surface. Consumption is visible only in
 * the Google Cloud console, or through Cloud Monitoring when accessed via
 * Vertex AI -- neither of which is reachable with a Gemini API key.
 *
 * So this adapter reports usage and limits as explicitly unsupported. That is
 * the honest result, and it is exactly the case the build plan warns about:
 * showing zero requests here would read as "healthy and idle" when the truth is
 * "we cannot see it".
 */

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const PROBE_URL = `${BASE_URL}/models`;

const NO_USAGE_API =
  'The Gemini Developer API exposes no usage or cost endpoint. Consumption is visible only in the Google Cloud console, or via Cloud Monitoring when using Vertex AI.';

/**
 * Gemini accepts the key either as a `?key=` query parameter or an
 * `x-goog-api-key` header. The header is used deliberately: a key in the URL
 * ends up in access logs, proxy logs and error reports.
 */
function authHeaders(credential: ProviderCredential): Record<string, string> {
  return { 'x-goog-api-key': credential.apiKey };
}

const probe: ProbeConfig = {
  url: PROBE_URL,
  headers: authHeaders,
};

export const geminiAdapter: AIProviderAdapter = {
  type: 'google_gemini',
  displayName: 'Google Gemini',
  category: 'llm',

  capabilities: {
    usage: 'none',
    cost: 'none',
    limits: 'none',
    meters: ['requests', 'tokens'],
    notes:
      'The Gemini Developer API has no usage, cost or quota endpoint. Only reachability and credential validity can be monitored; consumption must be read from the Google Cloud console.',
  },

  async validateCredentials(credential) {
    return probeCredential(probe, credential);
  },

  async fetchHealth(credential) {
    return probeHealth(probe, credential);
  },

  async fetchLimits(): Promise<NormalizedLimits> {
    return noLimits('unsupported', NO_USAGE_API);
  },

  async fetchUsage(): Promise<UsageResult> {
    return { supported: false, reason: 'unsupported', detail: NO_USAGE_API };
  },

  /** Nothing to normalize: there is no usage payload to receive. */
  normalizeMetrics(): readonly NormalizedUsage[] {
    return [];
  },
};
