import { classifyValidation } from '@/lib/credentials/validation-outcome';
import { PROVIDER_DEGRADED_LATENCY_MS } from '@/lib/providers/probe';
import type {
  CredentialValidation,
  NormalizedLimits,
  ProviderCapabilities,
  ProviderHealth,
  UsageResult,
} from '@/lib/providers/types';
import type { CollectorOutcome, UnavailableNote } from './types';

/**
 * Turning provider answers into collector state.
 *
 * Pure functions, so the judgement calls -- what counts as unhealthy, what
 * counts as a partial collection -- are tested directly instead of through a
 * network and a database.
 */

/**
 * Derives provider health from the single credential probe.
 *
 * One probe rather than a separate health call: on every adapter both hit the
 * same endpoint, and several return rate limits in the same response, so
 * calling twice would double the request count for no extra information.
 */
export function deriveHealth(validation: CredentialValidation): ProviderHealth {
  const latencyMs = validation.latencyMs;

  if (validation.valid) {
    return {
      status: latencyMs > PROVIDER_DEGRADED_LATENCY_MS ? 'degraded' : 'healthy',
      reachable: true,
      latencyMs,
      rateLimited: false,
    };
  }

  switch (validation.failure) {
    case 'rate_limited':
      // Answering, and the credential works -- just throttled.
      return {
        status: 'degraded',
        reachable: true,
        latencyMs,
        rateLimited: true,
        ...(validation.detail ? { error: validation.detail } : {}),
      };

    /**
     * Nothing was learned about the provider. A 403 commonly means a restricted
     * key that cannot list models but works for inference, and `misconfigured`
     * means the call never left this server.
     */
    case 'forbidden':
    case 'misconfigured':
      return {
        status: 'unknown',
        reachable: validation.failure === 'forbidden',
        latencyMs,
        rateLimited: false,
        ...(validation.detail ? { error: validation.detail } : {}),
      };

    default:
      return {
        status: 'unhealthy',
        reachable: false,
        latencyMs,
        rateLimited: false,
        ...(validation.detail ? { error: validation.detail } : {}),
      };
  }
}

/** What this run implies about the credential, reusing the Phase 4 rules. */
export function credentialOutcome(
  validation: CredentialValidation
): 'valid' | 'invalid' | 'unverified' {
  return classifyValidation(validation).outcome;
}

/** Metric groups whose absence is worth recording. */
const LIMIT_FIELDS = [
  'requestsLimit',
  'requestsRemaining',
  'tokensLimit',
  'tokensRemaining',
  'quotaUsed',
  'quotaLimit',
  'balance',
] as const;

/**
 * Collects the reasons metrics are missing, keyed by group.
 *
 * A provider that exposes nothing produces one note per group rather than
 * silence, because a UI showing a blank with no explanation is exactly what
 * the build plan warns against.
 */
export function collectUnavailable(
  capabilities: ProviderCapabilities,
  limits: NormalizedLimits,
  usage: UsageResult
): Record<string, UnavailableNote> {
  const notes: Record<string, UnavailableNote> = {};

  if (!usage.supported) {
    notes.usage = { reason: usage.reason, detail: usage.detail };
  }

  if (capabilities.cost === 'none') {
    notes.cost = {
      reason: 'unsupported',
      detail: 'This provider does not report cost; only the provider can price its own usage.',
    };
  }

  /**
   * Limits are reported field by field, so the first genuinely missing one is
   * recorded. A provider error is preferred over "unsupported" when both
   * appear: an outage is actionable, a permanent gap is not.
   */
  const firstUnavailable = LIMIT_FIELDS.map((field) => limits[field]).find(
    (metric) => !metric.available
  );
  const erroring = LIMIT_FIELDS.map((field) => limits[field]).find(
    (metric) => !metric.available && metric.reason === 'provider_error'
  );
  const chosen = erroring ?? firstUnavailable;

  if (chosen && !chosen.available) {
    notes.limits = { reason: chosen.reason, detail: chosen.detail };
  }

  return notes;
}

/** True when any limit field failed because the call itself failed. */
export function limitsErrored(limits: NormalizedLimits): boolean {
  return LIMIT_FIELDS.some((field) => {
    const metric = limits[field];
    return !metric.available && metric.reason === 'provider_error';
  });
}

/**
 * Classifies the collection, not the provider's health.
 *
 * A provider with no usage API is a complete success: everything it offers was
 * collected. Conflating "exposes little" with "went wrong" would make a healthy
 * Gemini key look permanently broken.
 */
export function classifyOutcome(
  health: ProviderHealth,
  limits: NormalizedLimits,
  usage: UsageResult
): CollectorOutcome {
  if (health.status === 'unhealthy') return 'failed';

  const usageFailed = !usage.supported && usage.reason === 'provider_error';

  if (usageFailed || limitsErrored(limits) || health.status === 'unknown') return 'partial';

  return 'success';
}
