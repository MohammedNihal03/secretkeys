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
 * number is alarming -- that is Phase 9 -- and nothing here knows how usage is
 * stored: that is the `UsageSink` seam at the bottom of this file.
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
  /**
   * Collection steps taken, including retries: the probe, the limits read and
   * the usage read.
   *
   * Deliberately not called a count of provider requests. Some adapters answer
   * a step locally -- a provider with no usage API needs no call -- and which
   * ones cannot be told from their declared capabilities, because the shared
   * OpenAI-compatible factory still makes a request to detect a 429 even when
   * it reports no limits. Counting steps is something this number can honestly
   * claim; counting HTTP requests is not.
   */
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

/** What the collection that produced a batch of usage rows observed. */
export interface UsageWriteContext {
  /** When the rows were collected. */
  collectedAt: Date;
  /** Round-trip latency of that collection's probe, when it was measured. */
  latencyMs: number | null;
}

export interface UsageWriteResult {
  /** Rows written or corrected. */
  stored: number;
  /** Rows deliberately not written -- unattributable, or carrying no metric. */
  skipped: number;
  /**
   * One message per distinct reason a row was skipped, ready to show an
   * operator. A silent skip would look identical to a provider reporting
   * nothing.
   */
  notes: string[];
}

/**
 * Where normalized usage goes.
 *
 * The collector produces normalized rows; the sink decides what storing them
 * means. Keeping the seam explicit is what let the collector be built and
 * tested in Phase 5 against a schema that did not exist yet, and it is what
 * lets `npm run collect --dry-run` exercise every provider without writing.
 */
export interface UsageSink {
  readonly name: string;
  write(
    target: CollectionTarget,
    entries: readonly NormalizedUsage[],
    context: UsageWriteContext
  ): Promise<UsageWriteResult>;
}
