import type { CredentialFailure } from '@/lib/providers/types';

/**
 * Retries for provider calls.
 *
 * Only failures that might answer differently a moment later are retried. A
 * rejected credential is not one of them: retrying a 401 three times turns one
 * clear "this key is wrong" into three, and on some providers repeated failed
 * auth is itself rate limited.
 */

export interface RetryOptions {
  /** Total tries, including the first. */
  attempts?: number;
  baseDelayMs?: number;
  /** Injectable for tests, so backoff is asserted without waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; returns 0..1. */
  random?: () => number;
}

export const DEFAULT_RETRY: Required<Pick<RetryOptions, 'attempts' | 'baseDelayMs'>> = {
  attempts: 3,
  baseDelayMs: 500,
};

/** Whether a provider failure is worth another try. */
export function isTransient(failure: CredentialFailure | undefined): boolean {
  switch (failure) {
    case 'network_error':
    case 'timeout':
    case 'rate_limited':
    // A 5xx, or anything unrecognised: the provider, not the credential.
    case 'unexpected_status':
      return true;
    // Definitive answers about the credential or our own configuration.
    case 'unauthorized':
    case 'forbidden':
    case 'misconfigured':
    default:
      return false;
  }
}

/**
 * Exponential backoff with full jitter.
 *
 * Jitter matters here because every credential for one provider is collected on
 * the same schedule: without it, a provider outage makes all of them retry in
 * lockstep and arrive as a burst the moment it recovers.
 */
export function backoffDelay(attempt: number, options: RetryOptions = {}): number {
  const base = options.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs;
  const random = options.random ?? Math.random;
  const ceiling = base * 2 ** (attempt - 1);

  return Math.round(ceiling * random());
}

export interface RetryResult<T> {
  result: T;
  /** How many tries were made, including the first. */
  attempts: number;
  /** Delays actually waited, for tests and for reporting retry pressure. */
  delays: number[];
}

/**
 * Runs `operation` until `shouldRetry` says the result is final, or the attempt
 * budget runs out. The last result is returned either way -- a retry that never
 * succeeds still has to report what happened.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  shouldRetry: (result: T) => boolean,
  options: RetryOptions = {}
): Promise<RetryResult<T>> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_RETRY.attempts);
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const delays: number[] = [];

  let result = await operation(1);

  for (let attempt = 1; attempt < attempts; attempt += 1) {
    if (!shouldRetry(result)) break;

    const delay = backoffDelay(attempt, options);
    delays.push(delay);
    await sleep(delay);

    result = await operation(attempt + 1);
  }

  return { result, attempts: delays.length + 1, delays };
}
