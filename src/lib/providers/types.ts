import type { HealthStatus } from '@/lib/health';
import type { AiProvider } from '@/lib/db/schema';

/**
 * The common provider interface.
 *
 * Providers differ enormously in what they expose. Of the seven adapters here,
 * only two report cost, only two report usage against a single key, and three
 * report no usage at all. The type system therefore makes "not available" a
 * value you must handle rather than something that quietly arrives as zero --
 * a missing metric shown as 0 requests would read as "healthy and idle" when
 * the truth is "we cannot see it".
 */

export type AiProviderType = AiProvider['type'];

/** Broad shape of a service, which determines how it meters consumption. */
export type ProviderCategory = 'llm' | 'speech';

/** What a provider charges by. Speech services do not meter in tokens. */
export type Meter = 'requests' | 'tokens' | 'characters' | 'audio_seconds';

/**
 * Why a metric could not be produced.
 *
 * These are distinct because they demand different responses: `unsupported` is
 * permanent and should be shown as "—" in the UI, `requires_admin_credential`
 * is an action an administrator can take, and `provider_error` is transient and
 * worth retrying.
 */
export type UnavailableReason =
  /** The provider exposes no API for this metric at all. */
  | 'unsupported'
  /**
   * Readable only with an organization-level admin credential, which is a
   * different secret from the project API key. OpenAI and Anthropic both work
   * this way.
   */
  | 'requires_admin_credential'
  /**
   * The provider reports usage for the whole organization keyed by its own
   * key identifier, and we have not recorded that identifier for this
   * credential, so the usage cannot be attributed to a project.
   */
  | 'requires_provider_key_id'
  /** The call was attempted and failed. */
  | 'provider_error';

export type Metric<T> =
  | { readonly available: true; readonly value: T }
  | { readonly available: false; readonly reason: UnavailableReason; readonly detail: string };

export function available<T>(value: T): Metric<T> {
  return { available: true, value };
}

export function unsupported<T>(detail: string): Metric<T> {
  return { available: false, reason: 'unsupported', detail };
}

export function requiresAdminCredential<T>(detail: string): Metric<T> {
  return { available: false, reason: 'requires_admin_credential', detail };
}

export function providerError<T>(detail: string): Metric<T> {
  return { available: false, reason: 'provider_error', detail };
}

/** Reads a metric's value, or a fallback when it is unavailable. */
export function metricOr<T>(metric: Metric<T>, fallback: T): T {
  return metric.available ? metric.value : fallback;
}

/** How a provider exposes usage and cost figures. */
export type UsageSource =
  /** Readable with the project API key itself. */
  | 'per_key'
  /** Readable only with an organization admin credential. */
  | 'organization_admin'
  /** Not exposed. */
  | 'none';

/** How a provider exposes rate limits and quotas. */
export type LimitsSource =
  /**
   * Only as headers on a normal API response, so limits are a side effect of
   * making a request rather than something that can be polled directly.
   */
  | 'response_headers'
  /** A dedicated endpoint that can be polled. */
  | 'endpoint'
  | 'none';

export interface ProviderCapabilities {
  readonly usage: UsageSource;
  readonly cost: UsageSource;
  readonly limits: LimitsSource;
  /** Units this provider meters in, which decides what the UI should show. */
  readonly meters: readonly Meter[];
  /**
   * Human-readable note on the provider's limitations, surfaced in the UI so an
   * administrator understands why a figure is missing rather than assuming the
   * dashboard is broken.
   */
  readonly notes: string;
}

/** A credential to act with. Never logged, never returned to a client. */
export interface ProviderCredential {
  readonly apiKey: string;
  /**
   * Provider-side project/organization scope, where the provider supports
   * scoping a request (e.g. OpenAI's `OpenAI-Project` header).
   */
  readonly providerProjectId?: string | null;
}

export type CredentialFailure =
  'unauthorized' | 'forbidden' | 'rate_limited' | 'network_error' | 'timeout' | 'unexpected_status';

export interface CredentialValidation {
  readonly valid: boolean;
  /** Set when invalid. Safe for display -- never contains the credential. */
  readonly failure?: CredentialFailure;
  readonly detail?: string;
  readonly latencyMs: number;
  /**
   * Identifiers learned while validating, for the caller to persist.
   *
   * Discovering the provider-side key id here is what later makes org-wide
   * usage attributable to a project.
   */
  readonly discovered?: {
    readonly providerKeyId?: string;
    readonly providerProjectId?: string;
  };
  /** Limits observed from response headers during the same call, if any. */
  readonly limits?: NormalizedLimits;
}

/**
 * Rate limits and quotas, normalized.
 *
 * Every field is a `Metric`, because providers expose wildly different
 * subsets -- Groq reports requests-per-day and tokens-per-minute, ElevenLabs
 * reports a character quota with a reset date, and Gemini reports nothing.
 */
export interface NormalizedLimits {
  readonly requestsLimit: Metric<number>;
  readonly requestsRemaining: Metric<number>;
  readonly tokensLimit: Metric<number>;
  readonly tokensRemaining: Metric<number>;
  /** Billing-period quota, for providers that meter a total allowance. */
  readonly quotaUsed: Metric<number>;
  readonly quotaLimit: Metric<number>;
  /** Unit the quota is expressed in. */
  readonly quotaUnit: Metric<Meter>;
  readonly resetsAt: Metric<Date>;
  /** True when the provider is currently rejecting calls with 429. */
  readonly rateLimited: boolean;
}

/** Normalized consumption over one time window. */
export interface NormalizedUsage {
  readonly windowStart: Date;
  readonly windowEnd: Date;

  readonly requests: Metric<number>;
  readonly successfulRequests: Metric<number>;
  readonly failedRequests: Metric<number>;

  readonly inputTokens: Metric<number>;
  readonly outputTokens: Metric<number>;
  readonly totalTokens: Metric<number>;

  /** Speech providers meter these instead of tokens. */
  readonly characters: Metric<number>;
  readonly audioSeconds: Metric<number>;

  /**
   * Cost as reported *by the provider*, never derived from a local price list.
   * Guessing at cost from a hardcoded pricing table would produce a confident
   * number that silently drifts every time a provider changes its prices.
   */
  readonly estimatedCostUsd: Metric<number>;

  /**
   * The provider's own key identifier this row is attributed to, when the
   * usage was reported org-wide and grouped by key.
   */
  readonly providerKeyId?: string;

  /**
   * Provider-specific fields preserved verbatim.
   *
   * Normalization necessarily loses detail (cache-read tokens, service tiers,
   * per-model splits). Keeping the original means later phases can use it
   * without re-collecting.
   */
  readonly providerRaw?: Record<string, unknown>;
}

export type UsageResult =
  | { readonly supported: true; readonly entries: readonly NormalizedUsage[] }
  | {
      readonly supported: false;
      readonly reason: UnavailableReason;
      readonly detail: string;
    };

export interface ProviderHealth {
  readonly status: HealthStatus;
  readonly reachable: boolean;
  readonly latencyMs: number;
  readonly httpStatus?: number;
  readonly rateLimited: boolean;
  /** Present on failure. Never contains the credential. */
  readonly error?: string;
}

/** Window to fetch usage for. */
export interface UsageWindow {
  readonly start: Date;
  readonly end: Date;
}

export interface UsageRequest {
  readonly credential: ProviderCredential;
  readonly window: UsageWindow;
  /**
   * Provider-side key ids to attribute org-wide usage to.
   *
   * Ignored by providers whose usage is already per-key.
   */
  readonly providerKeyIds?: readonly string[];
}

/**
 * A provider adapter.
 *
 * Implementations must never throw for a provider-side failure -- an
 * unreachable provider or a rejected credential is a reportable state, and a
 * collector that crashes on one provider stops collecting for all of them.
 */
export interface AIProviderAdapter {
  readonly type: AiProviderType;
  readonly displayName: string;
  readonly category: ProviderCategory;
  readonly capabilities: ProviderCapabilities;

  /** Checks a credential is accepted, and discovers identifiers where possible. */
  validateCredentials(credential: ProviderCredential): Promise<CredentialValidation>;

  /** Consumption over a window, or an explicit reason it is unavailable. */
  fetchUsage(request: UsageRequest): Promise<UsageResult>;

  /** Current rate limits and quotas. */
  fetchLimits(credential: ProviderCredential): Promise<NormalizedLimits>;

  /** Whether the provider is reachable and answering. */
  fetchHealth(credential: ProviderCredential): Promise<ProviderHealth>;

  /**
   * Pure transform from a provider's own payload shape to `NormalizedUsage`.
   *
   * Exposed separately from `fetchUsage` so it can be tested against recorded
   * fixtures without any network access, which is the only practical way to
   * pin down each provider's peculiar response shape.
   */
  normalizeMetrics(payload: unknown, window: UsageWindow): readonly NormalizedUsage[];
}

/** Every metric unavailable for the same reason. Used by adapters with no usage API. */
export function allUsageUnavailable(
  window: UsageWindow,
  reason: UnavailableReason,
  detail: string
): NormalizedUsage {
  const missing = <T>(): Metric<T> => ({ available: false, reason, detail });

  return {
    windowStart: window.start,
    windowEnd: window.end,
    requests: missing(),
    successfulRequests: missing(),
    failedRequests: missing(),
    inputTokens: missing(),
    outputTokens: missing(),
    totalTokens: missing(),
    characters: missing(),
    audioSeconds: missing(),
    estimatedCostUsd: missing(),
  };
}

/** No limits information at all. */
export function noLimits(reason: UnavailableReason, detail: string): NormalizedLimits {
  const missing = <T>(): Metric<T> => ({ available: false, reason, detail });

  return {
    requestsLimit: missing(),
    requestsRemaining: missing(),
    tokensLimit: missing(),
    tokensRemaining: missing(),
    quotaUsed: missing(),
    quotaLimit: missing(),
    quotaUnit: missing(),
    resetsAt: missing(),
    rateLimited: false,
  };
}
