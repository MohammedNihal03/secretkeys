import {
  aggregate,
  evaluateAll,
  rankFindings,
  rollUp,
  type Finding,
  type HealthLevel,
} from './engine';
import { AI_THRESHOLDS } from './thresholds';

/**
 * Judging an AI provider credential.
 *
 * Everything judged here comes from something collected: the probe's latency
 * and status, the usage rows the provider returned, and the limits it exposed.
 * Nothing is inferred from a price list or from what a provider is assumed to
 * do, which is why several of these evaluate to `unknown` for most providers --
 * Gemini and Groq report no usage at all, so their error rate is genuinely not
 * knowable, and saying so is the honest answer.
 */

export interface AiProviderState {
  /** Shown in the headline. */
  name: string;
  /** From the last collector run. */
  providerStatus: 'healthy' | 'degraded' | 'unhealthy' | 'unknown' | null;
  latencyMs: number | null;
  rateLimited: boolean;
  lastCollectedAt: Date | null;
  lastError: string | null;

  /** From stored usage over the window being shown. */
  requests: number | null;
  failedRequests: number | null;
  /** Why the failure count is missing, when it is. */
  failedRequestsDetail?: string | null;

  /** From the provider's limits, where it exposes them. */
  quotaUsedPercent: number | null;
  quotaDetail?: string | null;
  rateLimitRemainingPercent: number | null;
  rateLimitDetail?: string | null;
}

export interface AiAssessment {
  level: HealthLevel;
  headline: string;
  findings: Finding[];
}

/**
 * The error rate, or null when it cannot be computed.
 *
 * Two providers report requests without splitting them by outcome. Deriving a
 * rate of zero from that would claim every request succeeded, which is a
 * different statement from "this provider does not say".
 */
export function errorRatePercent(requests: number | null, failed: number | null): number | null {
  if (requests === null || failed === null) return null;
  if (requests <= 0) return null;

  return (failed / requests) * 100;
}

export function assessProvider(state: AiProviderState): AiAssessment {
  if (state.providerStatus === null || state.lastCollectedAt === null) {
    return {
      level: 'unknown',
      headline: `${state.name} has not been collected from yet.`,
      findings: [],
    };
  }

  if (state.providerStatus === 'unhealthy') {
    return {
      level: 'critical',
      headline: state.lastError
        ? `${state.name} could not be reached: ${state.lastError}`
        : `${state.name} could not be reached.`,
      findings: [
        {
          metric: 'ai.reachable',
          label: 'Availability',
          level: 'critical',
          value: 0,
          unit: null,
          message: state.lastError ?? 'The provider did not answer.',
        },
      ],
    };
  }

  const rate = errorRatePercent(state.requests, state.failedRequests);

  const readings = [
    {
      metric: 'ai.errorRatePercent',
      value: rate,
      reason: rate === null ? 'unsupported' : null,
      detail:
        state.failedRequestsDetail ??
        (state.requests === null
          ? `${state.name} does not report usage, so an error rate cannot be computed.`
          : `${state.name} reports requests without splitting them by outcome.`),
    },
    {
      metric: 'ai.latencyMs',
      value: state.latencyMs,
      reason: state.latencyMs === null ? 'provider_error' : null,
      detail: 'The last collection did not measure a round trip.',
    },
    {
      metric: 'ai.quotaUsedPercent',
      value: state.quotaUsedPercent,
      reason: state.quotaUsedPercent === null ? 'unsupported' : null,
      detail: state.quotaDetail ?? `${state.name} does not expose a quota.`,
    },
    {
      metric: 'ai.rateLimitRemainingPercent',
      value: state.rateLimitRemainingPercent,
      reason: state.rateLimitRemainingPercent === null ? 'unsupported' : null,
      detail: state.rateLimitDetail ?? `${state.name} does not expose rate-limit headroom.`,
    },
  ];

  const findings = rankFindings(evaluateAll(readings, AI_THRESHOLDS));

  /**
   * Being rate limited right now is a fact, not a threshold: the provider has
   * already refused a request, so it outranks whatever the headroom percentage
   * happens to say.
   */
  if (state.rateLimited) {
    findings.unshift({
      metric: 'ai.rateLimited',
      label: 'Rate limiting',
      level: 'warning',
      value: 1,
      unit: null,
      message: `${state.name} rate-limited the last collection. Requests are being refused, not just slowed.`,
    });
  }

  /**
   * Most providers expose no usage at all, so nearly every finding here is a
   * structural unknown. Letting those decide would report a working Gemini key
   * as `unknown` forever.
   */
  const level = state.providerStatus === 'degraded' ? 'warning' : rollUp(findings);
  const worst = findings.find((finding) => finding.level === level);

  return {
    level,
    headline:
      level === 'healthy'
        ? `${state.name} is healthy.`
        : level === 'unknown'
          ? `${state.name} is reachable, but reports little that can be judged.`
          : (worst?.message ?? `${state.name} needs attention.`),
    findings,
  };
}

/** Rolls several providers up into one level for an organization. */
export function assessProviders(states: readonly AiProviderState[]): {
  level: HealthLevel;
  assessments: (AiAssessment & { name: string })[];
} {
  const assessments = states.map((state) => ({ name: state.name, ...assessProvider(state) }));

  return {
    level: aggregate(assessments.map((assessment) => assessment.level)),
    assessments,
  };
}
