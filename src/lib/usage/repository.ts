import { and, asc, count, desc, eq, gte, lt, lte, max, min, sql, sum, type SQL } from 'drizzle-orm';

import type { PgColumn } from 'drizzle-orm/pg-core';

import { getDb } from '@/lib/db/client';
import { aiProviders, aiUsage, apiKeys, projects } from '@/lib/db/schema';
import type { KeyDirectory } from './attribution';
import type { UsageRowInput } from './normalize';

/**
 * Reading and writing the AI usage time series.
 *
 * Every read is scoped by organization id in its `where`, never by the caller
 * remembering to filter -- the same discipline the composite foreign keys
 * enforce on writes.
 */

/**
 * How many rows go in one statement.
 *
 * A daily-bucket provider returns a handful of rows per credential, so this is
 * headroom rather than a routine path; it exists so a first collection over a
 * long window cannot build a statement with tens of thousands of parameters.
 */
const INSERT_CHUNK = 500;

/**
 * The organization's keys for one provider, indexed by the provider's own
 * identifier.
 *
 * Every status is included, not just active ones: usage a revoked key produced
 * last week is still that key's usage, and dropping it would make a month's
 * total shrink the moment a credential is rotated.
 */
export async function loadKeyDirectory(
  organizationId: string,
  providerId: string
): Promise<KeyDirectory> {
  const rows = await getDb()
    .select({
      apiKeyId: apiKeys.id,
      projectId: apiKeys.projectId,
      providerKeyId: apiKeys.providerKeyId,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.providerId, providerId)));

  const directory = new Map<string, { apiKeyId: string; projectId: string }>();

  for (const row of rows) {
    if (!row.providerKeyId) continue;
    directory.set(row.providerKeyId, { apiKeyId: row.apiKeyId, projectId: row.projectId });
  }

  return directory;
}

/**
 * Writes intervals, correcting any already stored.
 *
 * An upsert rather than an insert because the collector deliberately re-reads
 * an overlapping window on every run: providers finalise usage late, so
 * yesterday's numbers can still change. The newest reading wins outright rather
 * than being merged with the old one -- a provider that revises an interval
 * downward (a refund, a corrected model split) must be able to revise it down.
 */
export async function upsertUsageRows(rows: readonly UsageRowInput[]): Promise<number> {
  if (rows.length === 0) return 0;

  const db = getDb();
  let stored = 0;

  for (let index = 0; index < rows.length; index += INSERT_CHUNK) {
    const chunk = rows.slice(index, index + INSERT_CHUNK);

    const written = await db
      .insert(aiUsage)
      .values([...chunk])
      .onConflictDoUpdate({
        target: [aiUsage.apiKeyId, aiUsage.timestamp, aiUsage.windowEnd],
        set: {
          // Attribution can move if a key is re-registered to another project.
          projectId: sql`excluded.project_id`,
          providerId: sql`excluded.provider_id`,
          requests: sql`excluded.requests`,
          successfulRequests: sql`excluded.successful_requests`,
          failedRequests: sql`excluded.failed_requests`,
          inputTokens: sql`excluded.input_tokens`,
          outputTokens: sql`excluded.output_tokens`,
          totalTokens: sql`excluded.total_tokens`,
          characters: sql`excluded.characters`,
          audioSeconds: sql`excluded.audio_seconds`,
          estimatedCost: sql`excluded.estimated_cost`,
          errorCount: sql`excluded.error_count`,
          rateLimitCount: sql`excluded.rate_limit_count`,
          latencyMs: sql`excluded.latency_ms`,
          providerKeyId: sql`excluded.provider_key_id`,
          unavailable: sql`excluded.unavailable`,
          providerRaw: sql`excluded.provider_raw`,
          // `updated_at` is the trigger's, not ours.
        },
      })
      .returning({ id: aiUsage.id });

    stored += written.length;
  }

  return stored;
}

/** Filters every usage read accepts. */
export interface UsageQuery {
  organizationId: string;
  /** Inclusive. */
  from: Date;
  /** Exclusive, so adjacent ranges neither overlap nor leave a gap. */
  to: Date;
  projectId?: string;
  providerId?: string;
  apiKeyId?: string;
}

function scope(query: UsageQuery): SQL {
  const clauses: SQL[] = [
    eq(aiUsage.organizationId, query.organizationId),
    gte(aiUsage.timestamp, query.from),
    lt(aiUsage.timestamp, query.to),
  ];

  if (query.projectId) clauses.push(eq(aiUsage.projectId, query.projectId));
  if (query.providerId) clauses.push(eq(aiUsage.providerId, query.providerId));
  if (query.apiKeyId) clauses.push(eq(aiUsage.apiKeyId, query.apiKeyId));

  // `and` returns undefined only for an empty list, and this list is never empty.
  return and(...clauses) as SQL;
}

/**
 * Sums, in which null means "no interval in range reported this".
 *
 * SQL `sum` ignores nulls and returns null when every input is null, which is
 * exactly the distinction this system cares about: a zero would claim the
 * provider reported no usage, while null says it reported no figure. The
 * `*Intervals` counts say how much of the range each total actually covers, so
 * a partial answer can be labelled as one instead of read as a total.
 */
export interface UsageTotals {
  intervals: number;
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
  /** Intervals that carried a provider-reported cost. */
  costIntervals: number;
  /** Earliest and latest interval contributing to these totals. */
  firstInterval: Date | null;
  lastInterval: Date | null;
}

/**
 * `sum()` comes back as a string from the driver (numeric and bigint both
 * exceed a JS number's exact range), so every total is parsed once here rather
 * than at each call site.
 */
function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const totalsSelection = {
  intervals: count(),
  requests: sum(aiUsage.requests),
  successfulRequests: sum(aiUsage.successfulRequests),
  failedRequests: sum(aiUsage.failedRequests),
  inputTokens: sum(aiUsage.inputTokens),
  outputTokens: sum(aiUsage.outputTokens),
  totalTokens: sum(aiUsage.totalTokens),
  characters: sum(aiUsage.characters),
  audioSeconds: sum(aiUsage.audioSeconds),
  estimatedCost: sum(aiUsage.estimatedCost),
  errorCount: sum(aiUsage.errorCount),
  rateLimitCount: sum(aiUsage.rateLimitCount),
  costIntervals: count(aiUsage.estimatedCost),
  // Drizzle's helpers, not hand-written SQL: they carry the column's own
  // decoder, so these come back as Dates rather than driver strings.
  firstInterval: min(aiUsage.timestamp),
  lastInterval: max(aiUsage.timestamp),
} as const;

type TotalsRow = { [K in keyof typeof totalsSelection]: string | number | Date | null };

function readTotals(row: TotalsRow | undefined): UsageTotals {
  return {
    intervals: Number(row?.intervals ?? 0),
    requests: toNumber((row?.requests ?? null) as string | null),
    successfulRequests: toNumber((row?.successfulRequests ?? null) as string | null),
    failedRequests: toNumber((row?.failedRequests ?? null) as string | null),
    inputTokens: toNumber((row?.inputTokens ?? null) as string | null),
    outputTokens: toNumber((row?.outputTokens ?? null) as string | null),
    totalTokens: toNumber((row?.totalTokens ?? null) as string | null),
    characters: toNumber((row?.characters ?? null) as string | null),
    audioSeconds: toNumber((row?.audioSeconds ?? null) as string | null),
    estimatedCost: toNumber((row?.estimatedCost ?? null) as string | null),
    errorCount: toNumber((row?.errorCount ?? null) as string | null),
    rateLimitCount: toNumber((row?.rateLimitCount ?? null) as string | null),
    costIntervals: Number(row?.costIntervals ?? 0),
    firstInterval: (row?.firstInterval as Date | null) ?? null,
    lastInterval: (row?.lastInterval as Date | null) ?? null,
  };
}

/** Totals over a range, for the whole organization or a slice of it. */
export async function summarizeUsage(query: UsageQuery): Promise<UsageTotals> {
  const [row] = await getDb().select(totalsSelection).from(aiUsage).where(scope(query));

  return readTotals(row as TotalsRow | undefined);
}

export type UsageBucket = 'hour' | 'day' | 'week' | 'month';

/**
 * `date_trunc`'s unit has to be inlined rather than bound as a parameter:
 * Postgres cannot see `date_trunc($1, ts)` in the select list and `date_trunc(
 * $5, ts)` in the `group by` as the same expression, and rejects the query.
 * Interpolating a caller's string into SQL is how injection happens, so the
 * value is mapped through this closed set first -- only these four words can
 * ever reach the statement.
 */
const BUCKET_SQL: Record<UsageBucket, string> = {
  hour: "'hour'",
  day: "'day'",
  week: "'week'",
  month: "'month'",
};

export interface UsageSeriesPoint extends UsageTotals {
  bucket: Date;
}

/**
 * Time zone names are inlined for the same reason the bucket unit is, so this
 * is the guard that makes that safe: an IANA name is letters, digits and a few
 * separators, and nothing else is allowed near the statement.
 */
const TIME_ZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

/**
 * Where a day starts.
 *
 * Without this, `date_trunc` silently uses the database session's time zone --
 * a machine setting -- so the same data would produce different daily totals
 * after a server move, and neither answer would say which it was. UTC by
 * default because that is the day the providers bill in.
 */
function bucketExpression(bucket: UsageBucket, timeZone: string) {
  if (!TIME_ZONE_PATTERN.test(timeZone)) {
    throw new Error(`Unsupported time zone: ${timeZone}`);
  }

  const unit = sql.raw(BUCKET_SQL[bucket]);
  const zone = sql.raw(`'${timeZone}'`);

  return sql`(date_trunc(${unit}, ${aiUsage.timestamp} at time zone ${zone}) at time zone ${zone})`.mapWith(
    aiUsage.timestamp
  );
}

/**
 * A time series for charting.
 *
 * Buckets that contain no data are absent rather than zero-filled: a gap in
 * collection is not a period of no usage, and a chart that draws them the same
 * way tells an operator everything is fine while the collector is down.
 * Whoever renders it decides how to show the gap.
 *
 * Each point's `bucket` is the instant the interval starts in `timeZone`.
 */
export async function usageTimeSeries(
  query: UsageQuery,
  bucket: UsageBucket = 'day',
  timeZone = 'UTC'
): Promise<UsageSeriesPoint[]> {
  const truncated = bucketExpression(bucket, timeZone);

  const rows = await getDb()
    .select({ bucket: truncated, ...totalsSelection })
    .from(aiUsage)
    .where(scope(query))
    .groupBy(truncated)
    .orderBy(asc(truncated));

  return rows.map((row) => ({
    bucket: row.bucket,
    ...readTotals(row as TotalsRow),
  }));
}

export type UsageDimension = 'project' | 'provider' | 'apiKey';

export interface UsageBreakdownRow extends UsageTotals {
  id: string;
  name: string;
}

/**
 * Totals grouped by one level of the hierarchy.
 *
 * Joined to the naming tables here rather than in the caller so a breakdown can
 * be shown without a second round trip per row, and so a deleted-then-recreated
 * project cannot be labelled with a stale name held in application memory.
 */
/**
 * Costliest first, then by name.
 *
 * `nulls last` matters: Postgres sorts nulls first on a descending order, which
 * would put every provider that reports no cost at all above the one actually
 * spending the money.
 */
function byCostThen(name: PgColumn): SQL {
  return sql`${sum(aiUsage.estimatedCost)} desc nulls last, ${name} asc`;
}

export async function usageBreakdown(
  query: UsageQuery,
  dimension: UsageDimension
): Promise<UsageBreakdownRow[]> {
  const db = getDb();
  const where = scope(query);

  if (dimension === 'project') {
    const rows = await db
      .select({ id: projects.id, name: projects.name, ...totalsSelection })
      .from(aiUsage)
      .innerJoin(projects, eq(projects.id, aiUsage.projectId))
      .where(where)
      .groupBy(projects.id, projects.name)
      .orderBy(byCostThen(projects.name));

    return rows.map((row) => ({ id: row.id, name: row.name, ...readTotals(row as TotalsRow) }));
  }

  if (dimension === 'provider') {
    const rows = await db
      .select({ id: aiProviders.id, name: aiProviders.name, ...totalsSelection })
      .from(aiUsage)
      .innerJoin(aiProviders, eq(aiProviders.id, aiUsage.providerId))
      .where(where)
      .groupBy(aiProviders.id, aiProviders.name)
      .orderBy(byCostThen(aiProviders.name));

    return rows.map((row) => ({ id: row.id, name: row.name, ...readTotals(row as TotalsRow) }));
  }

  const rows = await db
    .select({ id: apiKeys.id, name: apiKeys.keyName, ...totalsSelection })
    .from(aiUsage)
    .innerJoin(apiKeys, eq(apiKeys.id, aiUsage.apiKeyId))
    .where(where)
    .groupBy(apiKeys.id, apiKeys.keyName)
    .orderBy(byCostThen(apiKeys.keyName));

  return rows.map((row) => ({ id: row.id, name: row.name, ...readTotals(row as TotalsRow) }));
}

/** The most recent interval stored for an organization, or null if none is. */
export async function latestUsageInterval(organizationId: string): Promise<Date | null> {
  const [row] = await getDb()
    .select({ timestamp: aiUsage.timestamp })
    .from(aiUsage)
    .where(eq(aiUsage.organizationId, organizationId))
    .orderBy(desc(aiUsage.timestamp))
    .limit(1);

  return row?.timestamp ?? null;
}

/**
 * Deletes intervals ending before a cut-off.
 *
 * Retention is the operator's decision; nothing prunes on its own. Kept here so
 * the deletion is a range scan on an indexed column rather than a table scan
 * someone writes by hand later.
 */
export async function pruneUsage(olderThan: Date, organizationId?: string): Promise<number> {
  /**
   * Unscoped, this deletes across every tenant, which is what a retention job
   * wants and what nothing else does. Pass an organization id unless you are
   * that job.
   */
  const scope = organizationId
    ? and(lte(aiUsage.windowEnd, olderThan), eq(aiUsage.organizationId, organizationId))
    : lte(aiUsage.windowEnd, olderThan);

  const deleted = await getDb().delete(aiUsage).where(scope).returning({ id: aiUsage.id });

  return deleted.length;
}
