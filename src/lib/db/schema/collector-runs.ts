import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { aiProviders } from './ai-providers';
import { apiKeys } from './api-keys';
import { primaryId, timestamps } from './columns';
import { collectorOutcomeEnum, healthStatusEnum } from './enums';
import { organizations } from './organizations';

/**
 * One attempt to collect from one credential.
 *
 * This is the collector's own audit trail, not the usage time series -- the
 * metrics themselves get their table in Phase 6. What lives here is what the
 * build plan asks the collector to know: provider status, latency, errors, and
 * when a credential was last collected successfully or last failed. Those are
 * answered by querying these rows rather than by keeping mutable "last seen"
 * columns that lose their history on every write.
 *
 * "The observability system itself must be observable."
 */
export const collectorRuns = pgTable(
  'collector_runs',
  {
    id: primaryId(),

    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    /**
     * Nullable: a future organization-level collection (an OpenAI admin key
     * covering every project at once) is not tied to a single credential.
     */
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'cascade' }),

    providerId: uuid('provider_id')
      .notNull()
      .references(() => aiProviders.id, { onDelete: 'restrict' }),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
    durationMs: integer('duration_ms').notNull(),

    outcome: collectorOutcomeEnum('outcome').notNull(),

    /** The provider's state as observed by this run. */
    providerStatus: healthStatusEnum('provider_status').notNull(),

    /** Round-trip time of the probe, in milliseconds. */
    latencyMs: integer('latency_ms'),

    rateLimited: boolean('rate_limited').notNull().default(false),

    /** How many tries this attempt needed, so retry pressure is visible. */
    attempts: integer('attempts').notNull().default(1),

    usageWindowStart: timestamp('usage_window_start', { withTimezone: true }),
    usageWindowEnd: timestamp('usage_window_end', { withTimezone: true }),

    /** Normalized rows the provider returned. */
    usageEntryCount: integer('usage_entry_count').notNull().default(0),

    /**
     * Rows actually stored. Zero until Phase 6 provides a sink, and recorded
     * separately from `usageEntryCount` so "collected but not yet stored" is
     * never mistaken for "the provider returned nothing".
     */
    usagePersistedCount: integer('usage_persisted_count').notNull().default(0),

    /**
     * Which metrics were unavailable and why, keyed by metric group.
     *
     * The whole point of the `Metric` type is that "unavailable" carries a
     * reason; throwing that away at the storage boundary would leave a UI
     * unable to distinguish "the provider has no such API" from "the call
     * failed".
     */
    unavailable: jsonb('unavailable').$type<Record<string, { reason: string; detail: string }>>(),

    /** Failure detail, already scrubbed of credentials. */
    error: text('error'),

    ...timestamps,
  },
  (table) => [
    // Ascending is enough: Postgres scans an index backwards for `order by desc`.
    index('collector_runs_org_started_idx').on(table.organizationId, table.startedAt),
    index('collector_runs_key_started_idx').on(table.apiKeyId, table.startedAt),
    index('collector_runs_outcome_idx').on(table.outcome),
  ]
);

export type CollectorRun = typeof collectorRuns.$inferSelect;
export type NewCollectorRun = typeof collectorRuns.$inferInsert;
