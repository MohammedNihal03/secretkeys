import {
  available,
  unsupported,
  type CredentialFailure,
  type Metric,
  type NormalizedLimits,
} from './types';

/**
 * HTTP client for provider calls.
 *
 * SECURITY: credentials are passed in headers and this module never logs a
 * request, a header, or a response body. `describeFailure` builds messages from
 * status codes and provider error *text* only. Provider error bodies sometimes
 * echo a truncated key, so the text is length-capped and scrubbed of anything
 * key-shaped before it is surfaced.
 *
 * Never throws for a network failure -- callers get a result object, because a
 * provider being unreachable is a state to report, not an exception.
 */

/** Providers are polled in the background; a hung call must not wedge a collector. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Cap on provider error text kept, to bound what can end up in a UI or log. */
const MAX_DETAIL_LENGTH = 300;

export interface ProviderRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

export interface ProviderResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Headers;
  readonly json: unknown;
  readonly text: string;
  readonly latencyMs: number;
}

export interface ProviderFailure {
  readonly ok: false;
  readonly failure: CredentialFailure;
  readonly detail: string;
  readonly latencyMs: number;
  readonly status?: number;
}

export type ProviderCallResult = ({ readonly ok: true } & ProviderResponse) | ProviderFailure;

/**
 * Removes anything resembling a credential from provider-supplied text.
 *
 * Providers do sometimes include a prefix of the offending key in an error
 * message. Scrubbing here means no adapter can accidentally propagate one into
 * a stored alert or a log line.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\bgsk_[A-Za-z0-9_-]{8,}/g, 'gsk_***')
    .replace(/\bAIza[A-Za-z0-9_-]{8,}/g, 'AIza***')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***')
    .replace(/\bToken\s+[A-Za-z0-9._-]{8,}/gi, 'Token ***');
}

function truncate(text: string): string {
  const scrubbed = scrubSecrets(text.trim().replace(/\s+/g, ' '));
  return scrubbed.length > MAX_DETAIL_LENGTH
    ? `${scrubbed.slice(0, MAX_DETAIL_LENGTH)}…`
    : scrubbed;
}

/** Maps an HTTP status to the failure category callers act on. */
export function classifyStatus(status: number): CredentialFailure {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limited';
  return 'unexpected_status';
}

/**
 * Performs a provider call.
 *
 * `AbortSignal.timeout` is not used, so that a timeout can be distinguished
 * from an unrelated abort and reported as `timeout` rather than a generic
 * network error.
 */
export async function providerFetch(request: ProviderRequest): Promise<ProviderCallResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const startedAt = performance.now();

  try {
    const response = await fetch(request.url, {
      method: request.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...request.headers,
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: controller.signal,
      // Provider responses are point-in-time measurements; never serve a cached one.
      cache: 'no-store',
    });

    const latencyMs = Math.round(performance.now() - startedAt);
    const text = await response.text();

    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // A provider returning HTML (a gateway error page) is not a crash.
      json = undefined;
    }

    if (!response.ok) {
      return {
        ok: false,
        failure: classifyStatus(response.status),
        detail: describeErrorBody(response.status, json, text),
        latencyMs,
        status: response.status,
      };
    }

    return { ok: true, status: response.status, headers: response.headers, json, text, latencyMs };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);

    if (timedOut) {
      return {
        ok: false,
        failure: 'timeout',
        detail: `No response within ${timeoutMs}ms`,
        latencyMs,
      };
    }

    return {
      ok: false,
      failure: 'network_error',
      detail: truncate(error instanceof Error ? error.message : 'network error'),
      latencyMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds a human-readable message from a provider's error body.
 *
 * Every provider nests its message differently, so the common shapes are
 * probed in turn before falling back to raw text.
 */
export function describeErrorBody(status: number, json: unknown, text: string): string {
  const message = extractMessage(json);
  return message ? `HTTP ${status}: ${truncate(message)}` : `HTTP ${status}: ${truncate(text)}`;
}

function extractMessage(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined;

  const root = json as Record<string, unknown>;

  // { error: { message } } -- OpenAI, Groq, Qwen, Gemini
  const error = root.error;
  if (typeof error === 'object' && error !== null) {
    const nested = (error as Record<string, unknown>).message;
    if (typeof nested === 'string') return nested;
  }

  // { error: "..." } -- Deepgram
  if (typeof error === 'string') return error;

  // { message } -- some Anthropic shapes
  if (typeof root.message === 'string') return root.message;

  // { detail: { message } } / { detail: "..." } -- ElevenLabs
  const detail = root.detail;
  if (typeof detail === 'string') return detail;
  if (typeof detail === 'object' && detail !== null) {
    const nested = (detail as Record<string, unknown>).message;
    if (typeof nested === 'string') return nested;
  }

  return undefined;
}

/** Parses a header as a non-negative integer, or `undefined` if absent/invalid. */
export function headerInt(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;

  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Parses the duration strings used in rate-limit reset headers.
 *
 * OpenAI and Groq express these as compact durations such as `6m0s`, `1.5s` or
 * `120ms` rather than seconds, so `Number()` yields NaN on most real values.
 * Returns milliseconds.
 */
export function parseDurationMs(raw: string | null): number | undefined {
  if (!raw) return undefined;

  const trimmed = raw.trim();

  // A bare number is seconds (the Retry-After convention).
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;

  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  const unitMs: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

  let total = 0;
  let matched = false;

  for (const [, amount, unit] of trimmed.matchAll(pattern)) {
    total += Number(amount) * unitMs[unit];
    matched = true;
  }

  return matched ? total : undefined;
}

/** Absolute reset instant from a duration-style header, relative to now. */
export function resetAtFromHeader(headers: Headers, name: string): Date | undefined {
  const ms = parseDurationMs(headers.get(name));
  return ms === undefined ? undefined : new Date(Date.now() + ms);
}

/**
 * Reads the OpenAI-style rate-limit headers.
 *
 * OpenAI, Groq and Qwen all share this header family, because Groq and Qwen
 * expose OpenAI-compatible endpoints -- so one reader serves all three.
 *
 * Note the semantics differ between them even though the names match: Groq
 * documents `x-ratelimit-limit-requests` as requests *per day* while OpenAI
 * scopes it per minute. The numbers are reported as-is; interpreting them is
 * the caller's job.
 */
export function readOpenAIStyleLimits(
  headers: Headers
): Pick<
  NormalizedLimits,
  'requestsLimit' | 'requestsRemaining' | 'tokensLimit' | 'tokensRemaining' | 'resetsAt'
> {
  const NOT_RETURNED = 'Provider did not return this header';

  const count = (name: string): Metric<number> => {
    const value = headerInt(headers, name);
    return value === undefined ? unsupported(NOT_RETURNED) : available(value);
  };

  const requestsReset = resetAtFromHeader(headers, 'x-ratelimit-reset-requests');
  const tokensReset = resetAtFromHeader(headers, 'x-ratelimit-reset-tokens');

  // The sooner of the two is when capacity next returns.
  const soonest = [requestsReset, tokensReset]
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return {
    requestsLimit: count('x-ratelimit-limit-requests'),
    requestsRemaining: count('x-ratelimit-remaining-requests'),
    tokensLimit: count('x-ratelimit-limit-tokens'),
    tokensRemaining: count('x-ratelimit-remaining-tokens'),
    resetsAt: soonest ? available(soonest) : unsupported(NOT_RETURNED),
  };
}
