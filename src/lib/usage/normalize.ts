import type { CollectionTarget, UsageWriteContext } from '@/lib/collector/types';
import type { Metric, NormalizedUsage } from '@/lib/providers/types';
import type { KeyAttribution } from './attribution';

/**
 * Turning a provider's normalized usage into a storable row.
 *
 * Pure on purpose: what becomes a number, what stays null, and how two reports
 * of the same interval combine are the decisions most likely to quietly corrupt
 * a time series, so they are testable without a database.
 */

/** Why one metric on one row is null. Keyed by the row's own field names. */
export interface MetricNote {
  reason: string;
  detail: string;
}

/**
 * A row ready for `ai_usage`.
 *
 * Deliberately not `NewAiUsageRow`: nothing here should be able to set `id`,
 * `createdAt` or `updatedAt`, which belong to the database.
 */
export interface UsageRowInput {
  organizationId: string;
  projectId: string;
  providerId: string;
  apiKeyId: string;
  timestamp: Date;
  windowEnd: Date;

  requests: number | null;
  successfulRequests: number | null;
  failedRequests: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  characters: number | null;
  audioSeconds: number | null;
  estimatedCost: number | null;
  errorCount: number | null;
  rateLimitCount: number | null;

  latencyMs: number | null;
  providerKeyId: string | null;
  unavailable: Record<string, MetricNote> | null;
  providerRaw: Record<string, unknown> | null;
}

/** Metric fields, in the order the build plan lists them. */
export const USAGE_METRIC_FIELDS = [
  'requests',
  'successfulRequests',
  'failedRequests',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'characters',
  'audioSeconds',
  'estimatedCost',
  'errorCount',
  'rateLimitCount',
] as const;

export type UsageMetricField = (typeof USAGE_METRIC_FIELDS)[number];

/**
 * Metrics no adapter reports yet.
 *
 * Stored as an explicit reason rather than left silent, so a null in these
 * columns reads as "nobody reports it" instead of "the collector forgot".
 */
const NOT_REPORTED: Record<string, MetricNote> = {
  errorCount: {
    reason: 'unsupported',
    detail: 'No provider adapter reports an error count for a usage interval yet.',
  },
  rateLimitCount: {
    reason: 'unsupported',
    detail: 'No provider adapter reports a rate-limit count for a usage interval yet.',
  },
};

/** Reads a metric, recording the reason when it has no value. */
function read(
  field: UsageMetricField,
  metric: Metric<number>,
  notes: Record<string, MetricNote>,
  round = true
): number | null {
  if (!metric.available) {
    notes[field] = { reason: metric.reason, detail: metric.detail };
    return null;
  }

  const value = metric.value;

  if (!Number.isFinite(value)) {
    /**
     * A provider that answers `NaN` or `Infinity` has told us nothing usable.
     * Storing it would poison every sum computed over the column.
     */
    notes[field] = {
      reason: 'provider_error',
      detail: `The provider reported a value that is not a finite number (${String(value)}).`,
    };
    return null;
  }

  return round ? Math.round(value) : value;
}

/** True when the provider reported at least one metric for this interval. */
export function hasReportedMetric(row: UsageRowInput): boolean {
  return USAGE_METRIC_FIELDS.some((field) => row[field] !== null);
}

export function toUsageRow(
  entry: NormalizedUsage,
  target: CollectionTarget,
  attribution: KeyAttribution,
  context: UsageWriteContext
): UsageRowInput {
  const notes: Record<string, MetricNote> = { ...NOT_REPORTED };

  const row: UsageRowInput = {
    organizationId: target.organizationId,
    projectId: attribution.projectId,
    providerId: target.providerId,
    apiKeyId: attribution.apiKeyId,
    timestamp: entry.windowStart,
    windowEnd: entry.windowEnd,

    requests: read('requests', entry.requests, notes),
    successfulRequests: read('successfulRequests', entry.successfulRequests, notes),
    failedRequests: read('failedRequests', entry.failedRequests, notes),
    inputTokens: read('inputTokens', entry.inputTokens, notes),
    outputTokens: read('outputTokens', entry.outputTokens, notes),
    totalTokens: read('totalTokens', entry.totalTokens, notes),
    characters: read('characters', entry.characters, notes),
    audioSeconds: read('audioSeconds', entry.audioSeconds, notes),
    // Money keeps its fractions; the column is numeric for exactly that reason.
    estimatedCost: read('estimatedCost', entry.estimatedCostUsd, notes, false),
    errorCount: null,
    rateLimitCount: null,

    latencyMs: context.latencyMs,
    providerKeyId: entry.providerKeyId ?? null,
    unavailable: null,
    providerRaw: entry.providerRaw ?? null,
  };

  row.unavailable = Object.keys(notes).length > 0 ? notes : null;
  return row;
}

/** The identity of one stored interval: what the unique constraint covers. */
export function intervalKey(row: UsageRowInput): string {
  return `${row.apiKeyId}|${row.timestamp.toISOString()}|${row.windowEnd.toISOString()}`;
}

/**
 * Combines rows that describe the same interval for the same credential.
 *
 * Providers split an interval further than we store it -- Deepgram returns one
 * row per endpoint, and a grouped usage endpoint can return one per model. The
 * unique constraint would reject the second row, and a single statement cannot
 * upsert the same key twice, so the split must be resolved before the write.
 *
 * Metrics are summed across the rows that reported them, which is the
 * normalization the build plan asks for. A metric no contributing row reported
 * stays null and keeps its reason; one reported by only some rows is the total
 * of those, because on a split "unavailable" almost always means "not
 * applicable to this slice" (a speech-to-text row meters no characters). Every
 * original payload is kept under `providerRaw.parts`, so the detail summing
 * loses is still on the row.
 */
export function mergeIntervals(rows: readonly UsageRowInput[]): UsageRowInput[] {
  const merged = new Map<string, UsageRowInput>();
  const parts = new Map<string, Record<string, unknown>[]>();

  for (const row of rows) {
    const key = intervalKey(row);
    const existing = merged.get(key);

    if (row.providerRaw) {
      parts.set(key, [...(parts.get(key) ?? []), row.providerRaw]);
    }

    if (!existing) {
      merged.set(key, { ...row });
      continue;
    }

    const notes: Record<string, MetricNote> = {
      ...(existing.unavailable ?? {}),
      ...(row.unavailable ?? {}),
    };

    for (const field of USAGE_METRIC_FIELDS) {
      const a = existing[field];
      const b = row[field];
      const total = a === null ? b : b === null ? a : a + b;

      existing[field] = total;
      if (total !== null) delete notes[field];
    }

    existing.unavailable = Object.keys(notes).length > 0 ? notes : null;
    // Both rows describe the same key, so either latency is equally true.
    existing.latencyMs = existing.latencyMs ?? row.latencyMs;
    existing.providerKeyId = existing.providerKeyId ?? row.providerKeyId;
  }

  for (const [key, row] of merged) {
    const collected = parts.get(key) ?? [];
    row.providerRaw = collected.length > 1 ? { parts: collected } : (collected[0] ?? null);
  }

  return [...merged.values()];
}
