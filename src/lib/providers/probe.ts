import { providerFetch, type ProviderCallResult } from './http';
import {
  noLimits,
  type CredentialValidation,
  type NormalizedLimits,
  type ProviderCredential,
  type ProviderHealth,
} from './types';

/**
 * Shared credential/health probing.
 *
 * All seven adapters validate a credential the same way: call a cheap
 * authenticated read-only endpoint and interpret the status. Only the URL, the
 * auth header and what can be learned from the response differ, so those are
 * the parameters and the logic lives here once.
 *
 * The probe endpoint must be free and side-effect free. Validating a key by
 * running an inference request would cost the user money every health check.
 */

export interface ProbeConfig {
  /** A cheap, authenticated, read-only endpoint -- never a billable one. */
  readonly url: string;
  /** Auth headers for this provider. */
  readonly headers: (credential: ProviderCredential) => Record<string, string>;
  /** Extracts limits from the probe response, where the provider exposes them. */
  readonly readLimits?: (result: Extract<ProviderCallResult, { ok: true }>) => NormalizedLimits;
  /** Extracts provider-side identifiers from the probe response body. */
  readonly discover?: (json: unknown) => {
    providerKeyId?: string;
    providerProjectId?: string;
  };
  readonly timeoutMs?: number;
}

/**
 * Latency above this is reported as degraded rather than healthy.
 *
 * Deliberately generous: this measures a metadata endpoint, and a provider
 * being slow to list models is a weak signal compared to inference latency,
 * which Phase 5 collects from real traffic.
 */
export const PROVIDER_DEGRADED_LATENCY_MS = 2_000;

export async function probeCredential(
  config: ProbeConfig,
  credential: ProviderCredential
): Promise<CredentialValidation> {
  const result = await providerFetch({
    url: config.url,
    headers: config.headers(credential),
    timeoutMs: config.timeoutMs,
  });

  if (!result.ok) {
    return {
      valid: false,
      failure: result.failure,
      detail: result.detail,
      latencyMs: result.latencyMs,
    };
  }

  const discovered = config.discover?.(result.json);

  return {
    valid: true,
    latencyMs: result.latencyMs,
    // Omit the key entirely when nothing was discovered, rather than an empty object.
    ...(discovered && (discovered.providerKeyId || discovered.providerProjectId)
      ? { discovered }
      : {}),
    ...(config.readLimits ? { limits: config.readLimits(result) } : {}),
  };
}

export async function probeHealth(
  config: ProbeConfig,
  credential: ProviderCredential
): Promise<ProviderHealth> {
  const result = await providerFetch({
    url: config.url,
    headers: config.headers(credential),
    timeoutMs: config.timeoutMs,
  });

  if (!result.ok) {
    /**
     * A rate-limited provider is degraded, not down: it is answering, and the
     * credential is valid. Treating 429 as unhealthy would page someone for
     * ordinary throttling.
     */
    const rateLimited = result.failure === 'rate_limited';

    return {
      status: rateLimited ? 'degraded' : 'unhealthy',
      reachable: rateLimited,
      latencyMs: result.latencyMs,
      rateLimited,
      error: result.detail,
      ...(result.status === undefined ? {} : { httpStatus: result.status }),
    };
  }

  return {
    status: result.latencyMs > PROVIDER_DEGRADED_LATENCY_MS ? 'degraded' : 'healthy',
    reachable: true,
    latencyMs: result.latencyMs,
    httpStatus: result.status,
    rateLimited: false,
  };
}

/**
 * Limits for a provider that only exposes them as headers on a real API call.
 *
 * The probe endpoint (listing models) does not carry rate-limit headers on
 * every provider, so an absent header means "not observed here", not "no
 * limit". Phase 5 records the headers seen on actual inference traffic, which
 * is the only place these numbers are reliably present.
 */
export async function limitsFromProbeHeaders(
  config: ProbeConfig,
  credential: ProviderCredential,
  fallbackDetail: string
): Promise<NormalizedLimits> {
  if (!config.readLimits) return noLimits('unsupported', fallbackDetail);

  const result = await providerFetch({
    url: config.url,
    headers: config.headers(credential),
    timeoutMs: config.timeoutMs,
  });

  if (!result.ok) return noLimits('provider_error', result.detail);

  return config.readLimits(result);
}
