import { and, asc, avg, count, desc, eq, gte, inArray, lt, lte, max, min, sql } from 'drizzle-orm';

import { getDb } from '@/lib/db/client';
import { databaseCollectorRuns, databaseMetrics, monitoredDatabases } from '@/lib/db/schema';
import { eachMetric } from './collect';
import type { CounterSample, DatabaseMetricsSink, DatabaseSnapshot, DatabaseTarget } from './types';

/**
 * Storing and reading the database metric time series.
 *
 * A snapshot arrives as a tree of metrics; it is stored as one row per metric,
 * including the ones that were unavailable. Storing the absences is the point:
 * a chart can then distinguish "the cache hit ratio fell" from "we stopped
 * being allowed to read it", and neither looks like a gap where the collector
 * simply did not run.
 */

/** Metrics whose value is text rather than a number. */
const TEXT_METRICS = new Set(['health.serverVersion']);

/** Metrics whose value is a timestamp, stored as epoch milliseconds and as text. */
const TIMESTAMP_METRICS = new Set(['postgres.statsResetAt']);

/**
 * Readings the collector produces that are not `DbMetric`s.
 *
 * Response time is the most important number the collector has -- it is the
 * answer to "is this database responding" -- and it is a plain field on the
 * health object rather than a metric, because it always exists when a
 * connection was made. It is stored under a metric name anyway so charts do not
 * need a special case.
 */
function plainReadings(snapshot: DatabaseSnapshot): { metric: string; value: number }[] {
  if (!snapshot.health.reachable) return [];

  return [
    { metric: 'health.responseTimeMs', value: snapshot.health.responseTimeMs },
    { metric: 'health.connectTimeMs', value: snapshot.health.connectTimeMs },
  ];
}

export interface MetricRowInput {
  organizationId: string;
  projectId: string;
  databaseId: string;
  timestamp: Date;
  metric: string;
  value: number | null;
  reason: string | null;
  detail: string | null;
  textValue: string | null;
}

/**
 * Flattens a snapshot into rows.
 *
 * Pure, so what gets stored -- and what a missing metric turns into -- can be
 * checked without a database.
 */
export function snapshotToRows(snapshot: DatabaseSnapshot): MetricRowInput[] {
  const base = {
    organizationId: snapshot.target.organizationId,
    projectId: snapshot.target.projectId,
    databaseId: snapshot.target.databaseId,
    timestamp: snapshot.startedAt,
  };

  const rows: MetricRowInput[] = plainReadings(snapshot).map((reading) => ({
    ...base,
    metric: reading.metric,
    value: reading.value,
    reason: null,
    detail: null,
    textValue: null,
  }));

  for (const { path, metric } of eachMetric(snapshot)) {
    if (!metric.available) {
      rows.push({
        ...base,
        metric: path,
        value: null,
        reason: metric.reason,
        detail: metric.detail,
        textValue: null,
      });
      continue;
    }

    const reading = metric.value;

    if (TIMESTAMP_METRICS.has(path)) {
      const at = reading instanceof Date ? reading : null;
      rows.push({
        ...base,
        metric: path,
        value: at ? at.getTime() : null,
        // Null here is a real answer -- the counters have never been reset.
        reason: at ? null : 'not_exposed_by_postgres',
        detail: at ? null : 'The statistics counters have never been reset on this database.',
        textValue: at ? at.toISOString() : null,
      });
      continue;
    }

    if (TEXT_METRICS.has(path) || typeof reading === 'string') {
      rows.push({
        ...base,
        metric: path,
        value: null,
        reason: null,
        detail: null,
        textValue: String(reading),
      });
      continue;
    }

    if (typeof reading === 'boolean') {
      // 1/0 so a boolean can be charted and aggregated like anything else,
      // with the word kept beside it for display.
      rows.push({
        ...base,
        metric: path,
        value: reading ? 1 : 0,
        reason: null,
        detail: null,
        textValue: String(reading),
      });
      continue;
    }

    if (typeof reading === 'number' && Number.isFinite(reading)) {
      rows.push({
        ...base,
        metric: path,
        value: reading,
        reason: null,
        detail: null,
        textValue: null,
      });
      continue;
    }

    /**
     * A metric that claimed to be available but is not a storable value. Kept
     * as an explicit failure rather than dropped, because silently losing a
     * metric is how a series develops a hole nobody can explain.
     */
    rows.push({
      ...base,
      metric: path,
      value: null,
      reason: 'query_error',
      detail: 'The collector produced a value that could not be stored.',
      textValue: null,
    });
  }

  return rows;
}

/** How many rows go in one statement. */
const INSERT_CHUNK = 500;

export async function storeMetricRows(rows: readonly MetricRowInput[]): Promise<number> {
  if (rows.length === 0) return 0;

  const db = getDb();
  let stored = 0;

  for (let index = 0; index < rows.length; index += INSERT_CHUNK) {
    const written = await db
      .insert(databaseMetrics)
      .values(rows.slice(index, index + INSERT_CHUNK))
      .returning({ id: databaseMetrics.id });

    stored += written.length;
  }

  return stored;
}

/** Records one collection attempt. */
export async function recordDatabaseRun(
  snapshot: DatabaseSnapshot,
  metricsStored: number
): Promise<void> {
  await getDb()
    .insert(databaseCollectorRuns)
    .values({
      organizationId: snapshot.target.organizationId,
      databaseId: snapshot.target.databaseId,
      startedAt: snapshot.startedAt,
      finishedAt: snapshot.finishedAt,
      outcome: snapshot.outcome,
      status: snapshot.status,
      reachable: snapshot.health.reachable,
      responseTimeMs: snapshot.health.reachable ? snapshot.health.responseTimeMs : null,
      metricsStored,
      privileges: snapshot.privileges
        ? (snapshot.privileges as unknown as Record<string, unknown>)
        : null,
      notes: snapshot.notes.length > 0 ? snapshot.notes : null,
      error: snapshot.error ?? null,
    });
}

/**
 * The counters the previous collection read, for computing rates.
 *
 * Read back out of the metric series rather than kept in a column of their own,
 * so there is one copy of each number and no way for the two to disagree. The
 * paths named here are exactly the ones `CounterSample` is built from.
 */
export async function previousCounterSample(target: DatabaseTarget): Promise<CounterSample | null> {
  const paths = [
    'postgres.committedTransactions',
    'queries.rolledBackTransactions',
    'postgres.blocksHit',
    'postgres.blocksRead',
    'queries.deadlocks',
    'resources.databaseSizeBytes',
    'postgres.statsResetAt',
  ];

  const [latest] = await getDb()
    .select({ timestamp: databaseMetrics.timestamp })
    .from(databaseMetrics)
    .where(
      and(
        eq(databaseMetrics.databaseId, target.databaseId),
        eq(databaseMetrics.metric, 'postgres.committedTransactions')
      )
    )
    .orderBy(desc(databaseMetrics.timestamp))
    .limit(1);

  if (!latest) return null;

  const rows = await getDb()
    .select({
      metric: databaseMetrics.metric,
      value: databaseMetrics.value,
      textValue: databaseMetrics.textValue,
    })
    .from(databaseMetrics)
    .where(
      and(
        eq(databaseMetrics.databaseId, target.databaseId),
        eq(databaseMetrics.timestamp, latest.timestamp),
        inArray(databaseMetrics.metric, paths)
      )
    );

  const byPath = new Map(rows.map((row) => [row.metric, row]));
  const read = (path: string): number | null => byPath.get(path)?.value ?? null;

  const commits = read('postgres.committedTransactions');
  const rollbacks = read('queries.rolledBackTransactions');
  const hit = read('postgres.blocksHit');
  const readBlocks = read('postgres.blocksRead');

  if (commits === null || rollbacks === null || hit === null || readBlocks === null) {
    /**
     * An incomplete previous sample cannot produce an honest rate, and half a
     * delta is worse than none.
     */
    return null;
  }

  const resetText = byPath.get('postgres.statsResetAt')?.textValue ?? null;

  return {
    collectedAt: latest.timestamp,
    xactCommit: commits,
    xactRollback: rollbacks,
    blocksHit: hit,
    blocksRead: readBlocks,
    deadlocks: read('queries.deadlocks') ?? 0,
    databaseSizeBytes: read('resources.databaseSizeBytes'),
    statsResetAt: resetText ? new Date(resetText) : null,
  };
}

/** The Phase 8 sink: stores every metric, including the unavailable ones. */
export const databaseMetricsStore: DatabaseMetricsSink = {
  name: 'database_metrics',

  async write(snapshot: DatabaseSnapshot) {
    const rows = snapshotToRows(snapshot);
    const stored = await storeMetricRows(rows);

    await recordDatabaseRun(snapshot, stored);

    const missing = rows.filter((row) => row.reason === 'insufficient_privilege').length;

    return {
      stored,
      notes:
        missing > 0
          ? [
              `${snapshot.target.name}: ${missing} metric(s) were stored as unavailable because the monitoring role cannot read them.`,
            ]
          : [],
    };
  },

  previousSample: previousCounterSample,
};

/** Filters every metric read accepts. */
export interface MetricQuery {
  organizationId: string;
  databaseId?: string;
  /** Inclusive. */
  from: Date;
  /** Exclusive, so adjacent ranges neither overlap nor leave a gap. */
  to: Date;
}

function scope(query: MetricQuery) {
  const clauses = [
    eq(databaseMetrics.organizationId, query.organizationId),
    gte(databaseMetrics.timestamp, query.from),
    lt(databaseMetrics.timestamp, query.to),
  ];

  if (query.databaseId) clauses.push(eq(databaseMetrics.databaseId, query.databaseId));

  return and(...clauses);
}

export interface MetricPoint {
  timestamp: Date;
  value: number | null;
  reason: string | null;
  detail: string | null;
  textValue: string | null;
}

/**
 * One metric's history, oldest first.
 *
 * Unavailable readings come back in place, with their reason, rather than being
 * filtered out -- a chart that drops them draws a straight line across an
 * outage.
 */
export async function metricHistory(
  query: MetricQuery & { databaseId: string },
  metric: string,
  limit = 1_000
): Promise<MetricPoint[]> {
  return getDb()
    .select({
      timestamp: databaseMetrics.timestamp,
      value: databaseMetrics.value,
      reason: databaseMetrics.reason,
      detail: databaseMetrics.detail,
      textValue: databaseMetrics.textValue,
    })
    .from(databaseMetrics)
    .where(and(scope(query), eq(databaseMetrics.metric, metric)))
    .orderBy(asc(databaseMetrics.timestamp))
    .limit(limit);
}

export interface MetricSummary {
  metric: string;
  samples: number;
  /** Samples that carried a value; the rest were unavailable. */
  readings: number;
  min: number | null;
  max: number | null;
  average: number | null;
  latest: number | null;
  latestAt: Date | null;
  /** Why the most recent reading was missing, when it was. */
  latestReason: string | null;
  latestDetail: string | null;
  latestText: string | null;
}

/**
 * The latest reading of every metric for one database, with range statistics.
 *
 * One query rather than one per metric: a dashboard showing twenty metrics for
 * ten databases would otherwise make two hundred round trips.
 */
export async function latestMetrics(
  organizationId: string,
  databaseId: string,
  since: Date
): Promise<MetricSummary[]> {
  const db = getDb();

  const statistics = await db
    .select({
      metric: databaseMetrics.metric,
      samples: count(),
      readings: count(databaseMetrics.value),
      min: min(databaseMetrics.value),
      max: max(databaseMetrics.value),
      average: avg(databaseMetrics.value),
    })
    .from(databaseMetrics)
    .where(
      and(
        eq(databaseMetrics.organizationId, organizationId),
        eq(databaseMetrics.databaseId, databaseId),
        gte(databaseMetrics.timestamp, since)
      )
    )
    .groupBy(databaseMetrics.metric);

  /**
   * `distinct on` is the one place raw SQL earns its keep: it takes the newest
   * row per metric in a single index scan, where the portable alternatives are
   * a self-join or a window function over the whole range.
   */
  const newest = await db.execute<{
    metric: string;
    value: number | null;
    reason: string | null;
    detail: string | null;
    text_value: string | null;
    timestamp: Date;
  }>(sql`
    select distinct on (${databaseMetrics.metric})
      ${databaseMetrics.metric} as metric,
      ${databaseMetrics.value} as value,
      ${databaseMetrics.reason} as reason,
      ${databaseMetrics.detail} as detail,
      ${databaseMetrics.textValue} as text_value,
      ${databaseMetrics.timestamp} as timestamp
    from ${databaseMetrics}
    where ${databaseMetrics.organizationId} = ${organizationId}
      and ${databaseMetrics.databaseId} = ${databaseId}
      and ${databaseMetrics.timestamp} >= ${since}
    order by ${databaseMetrics.metric}, ${databaseMetrics.timestamp} desc
  `);

  const latestByMetric = new Map(newest.rows.map((row) => [row.metric, row]));

  return statistics
    .map((row) => {
      const latest = latestByMetric.get(row.metric);

      return {
        metric: row.metric,
        samples: Number(row.samples),
        readings: Number(row.readings),
        min: row.min === null ? null : Number(row.min),
        max: row.max === null ? null : Number(row.max),
        average: row.average === null ? null : Number(row.average),
        latest: latest?.value ?? null,
        latestAt: latest?.timestamp ?? null,
        latestReason: latest?.reason ?? null,
        latestDetail: latest?.detail ?? null,
        latestText: latest?.text_value ?? null,
      };
    })
    .sort((a, b) => a.metric.localeCompare(b.metric));
}

/**
 * The newest reading of every metric, for every database in an organization.
 *
 * One `distinct on` rather than a query per database: a dashboard showing six
 * databases with thirty metrics each would otherwise make a hundred and eighty
 * round trips to render one page.
 */
export async function latestMetricsByDatabase(
  organizationId: string,
  since: Date
): Promise<Map<string, MetricSummary[]>> {
  const result = await getDb().execute<{
    database_id: string;
    metric: string;
    value: number | null;
    reason: string | null;
    detail: string | null;
    text_value: string | null;
    timestamp: Date;
  }>(sql`
    select distinct on (${databaseMetrics.databaseId}, ${databaseMetrics.metric})
      ${databaseMetrics.databaseId} as database_id,
      ${databaseMetrics.metric} as metric,
      ${databaseMetrics.value} as value,
      ${databaseMetrics.reason} as reason,
      ${databaseMetrics.detail} as detail,
      ${databaseMetrics.textValue} as text_value,
      ${databaseMetrics.timestamp} as timestamp
    from ${databaseMetrics}
    where ${databaseMetrics.organizationId} = ${organizationId}
      and ${databaseMetrics.timestamp} >= ${since}
    order by ${databaseMetrics.databaseId}, ${databaseMetrics.metric}, ${databaseMetrics.timestamp} desc
  `);

  const byDatabase = new Map<string, MetricSummary[]>();

  for (const row of result.rows) {
    const summaries = byDatabase.get(row.database_id) ?? [];

    summaries.push({
      metric: row.metric,
      /**
       * One sample, because this is the latest reading rather than a range.
       * A caller that needs min/max/average over a window asks `latestMetrics`
       * for a single database instead of inferring it from here.
       */
      samples: 1,
      readings: row.value === null ? 0 : 1,
      min: row.value,
      max: row.value,
      average: row.value,
      latest: row.value,
      latestAt: row.timestamp,
      latestReason: row.reason,
      latestDetail: row.detail,
      latestText: row.text_value,
    });

    byDatabase.set(row.database_id, summaries);
  }

  return byDatabase;
}

/** The most recent collection attempt for each database in an organization. */
export async function latestRuns(organizationId: string) {
  return getDb().execute<{
    database_id: string;
    name: string;
    started_at: Date;
    outcome: string;
    status: string;
    reachable: boolean;
    response_time_ms: number | null;
    error: string | null;
  }>(sql`
    select distinct on (${databaseCollectorRuns.databaseId})
      ${databaseCollectorRuns.databaseId} as database_id,
      ${monitoredDatabases.name} as name,
      ${databaseCollectorRuns.startedAt} as started_at,
      ${databaseCollectorRuns.outcome} as outcome,
      ${databaseCollectorRuns.status} as status,
      ${databaseCollectorRuns.reachable} as reachable,
      ${databaseCollectorRuns.responseTimeMs} as response_time_ms,
      ${databaseCollectorRuns.error} as error
    from ${databaseCollectorRuns}
    join ${monitoredDatabases}
      on ${monitoredDatabases.id} = ${databaseCollectorRuns.databaseId}
    where ${databaseCollectorRuns.organizationId} = ${organizationId}
    order by ${databaseCollectorRuns.databaseId}, ${databaseCollectorRuns.startedAt} desc
  `);
}

/**
 * Several metrics' histories in one query.
 *
 * A detail page charts three or four series; fetching them separately would be
 * three or four scans of the same index range for the same rows.
 */
export async function metricHistories(
  organizationId: string,
  databaseId: string,
  metrics: readonly string[],
  since: Date
): Promise<Map<string, MetricPoint[]>> {
  const rows = await getDb()
    .select({
      metric: databaseMetrics.metric,
      timestamp: databaseMetrics.timestamp,
      value: databaseMetrics.value,
      reason: databaseMetrics.reason,
      detail: databaseMetrics.detail,
      textValue: databaseMetrics.textValue,
    })
    .from(databaseMetrics)
    .where(
      and(
        eq(databaseMetrics.organizationId, organizationId),
        eq(databaseMetrics.databaseId, databaseId),
        gte(databaseMetrics.timestamp, since),
        inArray(databaseMetrics.metric, [...metrics])
      )
    )
    .orderBy(asc(databaseMetrics.timestamp));

  const byMetric = new Map<string, MetricPoint[]>();

  for (const row of rows) {
    const points = byMetric.get(row.metric) ?? [];
    points.push({
      timestamp: row.timestamp,
      value: row.value,
      reason: row.reason,
      detail: row.detail,
      textValue: row.textValue,
    });
    byMetric.set(row.metric, points);
  }

  return byMetric;
}

/**
 * One metric's history for every database in an organization.
 *
 * The dashboard draws a small trend beside each database; doing that with one
 * query per database would be a round trip per row on the busiest page in the
 * application.
 */
export async function metricHistoryByDatabase(
  organizationId: string,
  metric: string,
  since: Date,
  perDatabase = 48
): Promise<Map<string, MetricPoint[]>> {
  const rows = await getDb()
    .select({
      databaseId: databaseMetrics.databaseId,
      timestamp: databaseMetrics.timestamp,
      value: databaseMetrics.value,
      reason: databaseMetrics.reason,
      detail: databaseMetrics.detail,
      textValue: databaseMetrics.textValue,
    })
    .from(databaseMetrics)
    .where(
      and(
        eq(databaseMetrics.organizationId, organizationId),
        eq(databaseMetrics.metric, metric),
        gte(databaseMetrics.timestamp, since)
      )
    )
    .orderBy(asc(databaseMetrics.timestamp));

  const byDatabase = new Map<string, MetricPoint[]>();

  for (const row of rows) {
    const points = byDatabase.get(row.databaseId) ?? [];
    points.push({
      timestamp: row.timestamp,
      value: row.value,
      reason: row.reason,
      detail: row.detail,
      textValue: row.textValue,
    });
    byDatabase.set(row.databaseId, points);
  }

  /**
   * Only the most recent points are charted. A database collected every minute
   * for a day is 1,440 bars in a strip a few hundred pixels wide, which is
   * noise rather than a trend.
   */
  for (const [databaseId, points] of byDatabase) {
    byDatabase.set(databaseId, points.slice(-perDatabase));
  }

  return byDatabase;
}

/** Recent collection attempts for one database, newest first. */
export async function runsForDatabase(organizationId: string, databaseId: string, limit = 10) {
  return getDb()
    .select({
      id: databaseCollectorRuns.id,
      startedAt: databaseCollectorRuns.startedAt,
      finishedAt: databaseCollectorRuns.finishedAt,
      outcome: databaseCollectorRuns.outcome,
      status: databaseCollectorRuns.status,
      reachable: databaseCollectorRuns.reachable,
      responseTimeMs: databaseCollectorRuns.responseTimeMs,
      metricsStored: databaseCollectorRuns.metricsStored,
      notes: databaseCollectorRuns.notes,
      error: databaseCollectorRuns.error,
    })
    .from(databaseCollectorRuns)
    .where(
      and(
        eq(databaseCollectorRuns.organizationId, organizationId),
        eq(databaseCollectorRuns.databaseId, databaseId)
      )
    )
    .orderBy(desc(databaseCollectorRuns.startedAt))
    .limit(limit);
}

/**
 * Deletes readings older than a cut-off.
 *
 * This table grows by one row per metric per database per collection -- roughly
 * thirty rows every few minutes for a single database -- so retention is not
 * optional in the long run. It is still the operator's decision; nothing prunes
 * on its own.
 *
 * `organizationId` narrows it to one tenant. Without that parameter this is a
 * deployment-wide delete, which is right for a retention job and wrong for
 * everything else: an unscoped call from a test wiped every metric in the
 * developer's database, including data the dashboard was being checked against.
 * Scoping is not optional for any caller that is not the retention job itself.
 */
export async function pruneDatabaseMetrics(
  olderThan: Date,
  organizationId?: string
): Promise<number> {
  const scope = organizationId
    ? and(
        lte(databaseMetrics.timestamp, olderThan),
        eq(databaseMetrics.organizationId, organizationId)
      )
    : lte(databaseMetrics.timestamp, olderThan);

  const deleted = await getDb()
    .delete(databaseMetrics)
    .where(scope)
    .returning({ id: databaseMetrics.id });

  return deleted.length;
}
