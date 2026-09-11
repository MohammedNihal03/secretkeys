import { probeCredential, probeHealth, type ProbeConfig } from './probe';
import {
  noLimits,
  type AIProviderAdapter,
  type CredentialValidation,
  type NormalizedLimits,
  type NormalizedUsage,
  type ProviderCredential,
  type ProviderHealth,
  type UsageResult,
} from './types';

/**
 * Azure OpenAI adapter.
 *
 * Docs: https://learn.microsoft.com/en-us/rest/api/azureopenai/models/list
 *
 * Unlike every other provider here, the host is per resource:
 * `https://{resource}.openai.azure.com`. Authentication is an `api-key` header,
 * and `GET {endpoint}/openai/models?api-version=…` is a free, read-only probe.
 *
 * Usage, cost and quota live in Azure Monitor and Azure Cost Management, which
 * require Entra ID access to the subscription -- not the resource key -- so
 * they are reported as unavailable.
 *
 * SECURITY: because the endpoint is user-supplied, it is checked against an
 * allow-list of Azure hosts before any request. Without that, registering a key
 * would let an administrator make this server send an authenticated request to
 * any address, including internal services (SSRF).
 */

/** GA data-plane version, pinned so a new version cannot change responses. */
export const AZURE_API_VERSION = '2024-10-21';

/** Host suffixes Azure OpenAI resources are served from. */
export const AZURE_HOST_SUFFIXES = ['.openai.azure.com', '.cognitiveservices.azure.com'] as const;

/** A single DNS label: the resource name. */
const RESOURCE_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type EndpointResult = { ok: true; baseUrl: string } | { ok: false; error: string };

/**
 * Validates and normalizes an Azure OpenAI endpoint.
 *
 * Returns the bare origin, so any path, query or fragment a user pasted is
 * discarded rather than carried into requests.
 */
export function parseAzureEndpoint(raw: string): EndpointResult {
  let url: URL;

  try {
    url = new URL(raw.trim());
  } catch {
    return {
      ok: false,
      error: 'Enter the full endpoint URL, for example https://my-resource.openai.azure.com',
    };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, error: 'The endpoint must use https.' };
  }

  if (url.username || url.password) {
    return { ok: false, error: 'The endpoint must not contain credentials.' };
  }

  if (url.port && url.port !== '443') {
    return { ok: false, error: 'The endpoint must use the standard HTTPS port.' };
  }

  // `URL` lower-cases and punycode-encodes the host, so this compares ASCII.
  const host = url.hostname;
  const suffix = AZURE_HOST_SUFFIXES.find((candidate) => host.endsWith(candidate));
  const label = suffix ? host.slice(0, -suffix.length) : '';

  /**
   * Exactly one label before the suffix. Rejects the bare suffix, nested
   * subdomains, and look-alikes such as `openai.azure.com.example.com` (whose
   * suffix is not an Azure one at all).
   */
  if (!suffix || !RESOURCE_LABEL.test(label)) {
    return {
      ok: false,
      error: `The endpoint must be an Azure OpenAI resource, e.g. https://my-resource${AZURE_HOST_SUFFIXES[0]}`,
    };
  }

  return { ok: true, baseUrl: `https://${host}` };
}

function probeFor(credential: ProviderCredential): ProbeConfig | undefined {
  const parsed = credential.baseUrl ? parseAzureEndpoint(credential.baseUrl) : undefined;
  if (!parsed?.ok) return undefined;

  return {
    url: `${parsed.baseUrl}/openai/models?api-version=${AZURE_API_VERSION}`,
    headers: (c) => ({ 'api-key': c.apiKey }),
  };
}

const MISSING_ENDPOINT =
  'Azure OpenAI needs its resource endpoint (https://{resource}.openai.azure.com), and none that passes validation is set.';

export const azureOpenaiAdapter: AIProviderAdapter = {
  type: 'azure_openai',
  displayName: 'Azure OpenAI',
  category: 'llm',

  capabilities: {
    usage: 'none',
    cost: 'none',
    limits: 'none',
    meters: ['requests', 'tokens'],
    notes:
      'Needs the resource endpoint as well as the key. Usage, cost and quota live in Azure Monitor and Azure Cost Management, which require Entra ID access to the subscription rather than the resource key.',
  },

  async validateCredentials(credential): Promise<CredentialValidation> {
    const probe = probeFor(credential);

    // Refused before any request: there is no safe URL to call.
    if (!probe) {
      return { valid: false, failure: 'misconfigured', detail: MISSING_ENDPOINT, latencyMs: 0 };
    }

    return probeCredential(probe, credential);
  },

  async fetchHealth(credential): Promise<ProviderHealth> {
    const probe = probeFor(credential);

    if (!probe) {
      return {
        status: 'unknown',
        reachable: false,
        latencyMs: 0,
        rateLimited: false,
        error: MISSING_ENDPOINT,
      };
    }

    return probeHealth(probe, credential);
  },

  async fetchLimits(): Promise<NormalizedLimits> {
    return noLimits(
      'unsupported',
      'Azure OpenAI quota is managed in the Azure portal and Azure Monitor, not exposed to the resource key.'
    );
  },

  async fetchUsage(): Promise<UsageResult> {
    return {
      supported: false,
      reason: 'unsupported',
      detail:
        'Azure OpenAI reports usage and cost through Azure Monitor and Azure Cost Management, which need Entra ID access to the subscription rather than the resource API key.',
    };
  },

  normalizeMetrics(): readonly NormalizedUsage[] {
    return [];
  },
};
