import {
  boolean,
  doublePrecision,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from './columns';
import { monitoredDatabases } from './monitored-databases';
import { organizations } from './organizations';
import { projects } from './projects';

/**
 * The database metric time series.
 *
 * One row is one metric, for one database, at one instant:
 *
 *   Organization -> Project -> Monitored Database -> Metric -> Timestamp
 *
 * **Narrow rather than wide, deliberately.** A column per metric would mean a
 * migration every time PostgreSQL exposes something new, a table of mostly
 * nulls, and no way to record *why* a particular metric was missing at a
 * particular moment. One row per metric makes an unavailable metric a first
 * class thing to store -- which is what the build plan asks for when it says to
 * handle unavailable metrics explicitly instead of inventing values.
 *
 * The cost of that choice is that a dashboard reads several rows per database
 * instead of one, which is what the indexes below are shaped for.
 *
 * A row is written with `value` null and `reason` set when a metric could not
 * be produced. Those two states are different and both are worth keeping: "the
 * cache hit ratio was 12%" and "the monitoring role could not read it" are not
 * the same answer, and neither is a gap in the series.
 */
export const databaseMetrics = pgTable(
  'database_metrics',
  {
    id: primaryId(),

    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),

    databaseId: uuid('database_id')
      .notNull()
      .references(() => monitoredDatabases.id, { onDelete: 'cascade' }),

    /** When the collection that produced this reading started. */
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),

    /**
     * The metric's dotted path, e.g. `connections.utilizationPercent`. The
     * collector owns the vocabulary; storage does not enumerate it, so a new
     * metric needs no migration.
     */
    metric: text('metric').notNull(),

    /**
     * `double precision` covers every metric in one column: byte counts,
     * percentages, rates and counters. Money would need `numeric`; none of
     * these is money.
     */
    value: doublePrecision('value'),

    /**
     * Set when `value` is null: why this reading does not exist. One of the
     * collector's `DbUnavailableReason` values -- a missing grant, a figure
     * PostgreSQL does not expose, a rate still waiting for a second sample.
     */
    reason: text('reason'),

    /** The reason in full, as the operator should read it. */
    detail: text('detail'),

    /**
     * Non-numeric readings kept verbatim: the server version, whether the
     * server is in recovery, when the statistics were last reset. Stored beside
     * the number rather than in a second table, because they are answers to the
     * same question at the same instant.
     */
    textValue: text('text_value'),

    ...timestamps,
  },
  (table) => [
    /**
     * Organization isolation enforced by the database, as everywhere else.
     */
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: 'database_metrics_org_project_fk',
    }).onDelete('cascade'),

    /**
     * The chart query: one metric for one database over a range. Leading with
     * the database and the metric and ending with time makes it a single range
     * scan.
     */
    index('database_metrics_db_metric_time_idx').on(
      table.databaseId,
      table.metric,
      table.timestamp
    ),

    /** The dashboard query: everything about one organization at a time. */
    index('database_metrics_org_time_idx').on(table.organizationId, table.timestamp),

    /** Retention: delete by age across every tenant. */
    index('database_metrics_time_idx').on(table.timestamp),
  ]
);

export type DatabaseMetricRow = typeof databaseMetrics.$inferSelect;
export type NewDatabaseMetricRow = typeof databaseMetrics.$inferInsert;

/**
 * One row per collection, summarising the attempt.
 *
 * The collector's own audit trail, separate from the metrics: it answers "when
 * was this database last reached, and what went wrong" without scanning a
 * metric series, and it survives the retention that prunes the series.
 *
 * "The observability system itself must be observable."
 */
export const databaseCollectorRuns = pgTable(
  'database_collector_runs',
  {
    id: primaryId(),

    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    databaseId: uuid('database_id')
      .notNull()
      .references(() => monitoredDatabases.id, { onDelete: 'cascade' }),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),

    /** 'success' | 'partial' | 'failed' | 'skipped', from the collector. */
    outcome: text('outcome').notNull(),

    /** Availability as observed, not a threshold judgement. */
    status: text('status').notNull(),

    reachable: boolean('reachable').notNull(),
    /** Connecting plus one trivial query, in milliseconds. */
    responseTimeMs: doublePrecision('response_time_ms'),

    /** Metric rows this run stored. */
    metricsStored: doublePrecision('metrics_stored').notNull().default(0),

    /**
     * What the monitoring role could see, so a sudden loss of detail can be
     * traced to a revoked grant rather than to the database changing.
     */
    privileges: jsonb('privileges').$type<Record<string, unknown>>(),

    /** Advice for the operator, already scrubbed of credentials. */
    notes: jsonb('notes').$type<string[]>(),

    error: text('error'),

    ...timestamps,
  },
  (table) => [
    index('database_collector_runs_db_started_idx').on(table.databaseId, table.startedAt),
    index('database_collector_runs_org_started_idx').on(table.organizationId, table.startedAt),
  ]
);

export type DatabaseCollectorRun = typeof databaseCollectorRuns.$inferSelect;
export type NewDatabaseCollectorRun = typeof databaseCollectorRuns.$inferInsert;
