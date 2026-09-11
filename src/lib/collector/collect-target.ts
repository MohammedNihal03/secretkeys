import type {
  AIProviderAdapter,
  NormalizedLimits,
  ProviderCredential,
  UsageResult,
  UsageWindow,
} from '@/lib/providers/types';
import {
  classifyOutcome,
  collectUnavailable,
  credentialOutcome,
  deriveHealth,
  limitsErrored,
} from './interpret';
import { isTransient, withRetry, type RetryOptions } from './retry';
import type { CollectionTarget, TargetCollection } from './types';

/**
 * Collecting from one credential.
 *
 * Takes its adapter and credential as arguments rather than looking them up, so
 * the order of calls, the retry behaviour and the outcome rules can all be
 * tested without a network or a database.
 *
 * Never throws for a provider-side problem: an unreachable provider is a result
 * to record. The runner still guards against a genuine crash, because one
 * adapter must not be able to end a whole collection.
 */

export interface CollectTargetDeps {
  adapter: AIProviderAdapter;
  credential: ProviderCredential;
  window: UsageWindow;
  retry?: RetryOptions;
  now?: () => Date;
}

export async function collectTarget(
  target: CollectionTarget,
  deps: CollectTargetDeps
): Promise<TargetCollection> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const { adapter, credential, window } = deps;

  let attempts = 0;

  /**
   * One probe serves as both the credential check and the health signal, and
   * on several providers it also returns the rate limits.
   */
  const probe = await withRetry(
    () => adapter.validateCredentials(credential),
    (validation) => !validation.valid && isTransient(validation.failure),
    deps.retry
  );
  attempts += probe.attempts;

  const validation = probe.result;
  const health = deriveHealth(validation);

  // Only ask for limits separately when the probe did not already carry them.
  let limits: NormalizedLimits;
  if (validation.limits) {
    limits = validation.limits;
  } else {
    const limitsRun = await withRetry(
      () => adapter.fetchLimits(credential),
      (result) => limitsErrored(result),
      deps.retry
    );
    attempts += limitsRun.attempts;
    limits = limitsRun.result;
  }

  const exposesUsage = adapter.capabilities.usage !== 'none';
  let usage: UsageResult;

  if (exposesUsage && !health.reachable) {
    /**
     * The provider did not answer the probe, so a usage request would fail the
     * same way. Recorded as a provider error rather than attempted, which keeps
     * one outage from costing three requests per credential.
     */
    usage = {
      supported: false,
      reason: 'provider_error',
      detail: health.error ?? 'The provider could not be reached, so usage was not collected.',
    };
  } else {
    const usageRun = await withRetry(
      () => adapter.fetchUsage({ credential, window }),
      (result) => !result.supported && result.reason === 'provider_error',
      deps.retry
    );
    // A provider with no usage API answers locally; that is not a request.
    attempts += exposesUsage ? usageRun.attempts : 0;
    usage = usageRun.result;
  }

  const finishedAt = now();
  const outcome = classifyOutcome(health, limits, usage);
  const unavailable = collectUnavailable(adapter.capabilities, limits, usage);

  return {
    target,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    attempts,
    health,
    limits,
    usage,
    entries: usage.supported ? usage.entries : [],
    outcome,
    unavailable,
    ...(health.error ? { error: health.error } : {}),
    credentialOutcome: credentialOutcome(validation),
    usageWindow: window,
    // Set by the runner once a sink has reported what it stored.
    persisted: 0,
  };
}
