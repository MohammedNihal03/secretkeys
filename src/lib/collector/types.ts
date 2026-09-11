import type { HealthStatus } from '@/lib/health';
import type { Environment } from '@/lib/projects/schema';
import type {
  AiProviderType,
  NormalizedLimits,
  NormalizedUsage,
  ProviderHealth,
  UsageResult,
  UsageWindow,
} from '@/lib/providers/types';

/**
 * Collector vocabulary.
 *
 * The collector's job is to turn "a credential exists" into "here is what its
 * provider will tell us, and what it will not". Nothing here decides whether a
 * number is alarming -- that is Phase 9 -- and nothing here stores the usage
 * time series, which is Phase 6.
 */

export type CollectorOutcome = 'success' | 'partial' | 'failed' | 'skipped';

/** One credential to collect from, with everything needed to attribute it. */
export interface CollectionTarget {
  organizationId: string;
  organizationName: string;
  projectId: string;
  projectName: string;
  providerId: string;
  providerType: AiProviderType;
  providerName: string;
  apiKeyId: string;
  keyName: string;
  environment: Environment;
}

/** Why one group of metrics is missing. Kept verbatim for the UI to explain. */
export interface UnavailableNote {
  reason: string;
  detail: string;
}

/** The result of collecting from a single target. */
export interface TargetCollection {
  target: CollectionTarget;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  /** Total provider calls made, including retries. */
  attempts: number;

  health: ProviderHealth;
  limits: NormalizedLimits;
  usage: UsageResult;
  /** Normalized rows, ready for a sink. Empty when usage is unavailable. */
  entries: readonly NormalizedUsage[];

  outcome: CollectorOutcome;
  unavailable: Record<string, UnavailableNote>;
  error?: string;

  /**
   * What this run implies about the credential itself, so a key revoked at the
   * provider stops showing as validated.
   */
  credentialOutcome: 'valid' | 'invalid' | 'unverified';

  usageWindow: UsageWindow;
  /** Rows the sink reported storing. */
  persisted: number;
}

/** A row to write to `collector_runs`. */
export interface CollectorRunRecord {
  organizationId: string;
  apiKeyId: string | null;
  providerId: string;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  outcome: CollectorOutcome;
  providerStatus: HealthStatus;
  latencyMs: number | null;
  rateLimited: boolean;
  attempts: number;
  usageWindowStart: Date | null;
  usageWindowEnd: Date | null;
  usageEntryCount: number;
  usagePersistedCount: number;
  unavailable: Record<string, UnavailableNote> | null;
  error: string | null;
}

export interface ProviderSummary {
  targets: number;
  success: number;
  partial: number;
  failed: number;
  usageEntries: number;
}

export interface CollectionSummary {
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  /**
   * False when another collection already held the lock, so this run did
   * nothing. Distinct from a run that found no targets.
   */
  ran: boolean;
  targets: number;
  success: number;
  partial: number;
  failed: number;
  skipped: number;
  usageEntries: number;
  usagePersisted: number;
  byProvider: Record<string, ProviderSummary>;
  /** Messages worth showing an operator, already scrubbed of credentials. */
  problems: string[];
}

/**
 * Where normalized usage goes.
 *
 * Phase 5 ends here on purpose: the collector produces normalized rows, and
 * Phase 6 supplies the sink that stores them. Keeping the seam explicit means
 * the collector can be built and tested now without guessing at a schema the
 * build plan specifies later.
 */
export interface UsageSink {
  readonly name: string;
  /** Returns how many rows were stored. */
  write(target: CollectionTarget, entries: readonly NormalizedUsage[]): Promise<number>;
}
