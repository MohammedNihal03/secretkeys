import {
  bigint,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { aiProviders } from './ai-providers';
import { apiKeys } from './api-keys';
import { primaryId, timestamps } from './columns';
import { organizations } from './organizations';
import { projects } from './projects';

/**
 * The AI usage time series.
 *
 * One row is one provider-reported interval for one credential, which is what
 * makes the hierarchy the build plan asks for resolvable by query alone:
 *
 *   Organization -> Project -> Provider -> API Key -> Time -> Usage
 *
 * Every level is a column on the row rather than something to be reached by
 * joining, because every dashboard question ("this month's spend for project
 * X", "tokens per provider") is a filtered aggregate over time and would
 * otherwise pay for four joins on the largest table in the database.
 *
 * Two rules this schema exists to keep:
 *
 * 1. **Nothing is invented.** Every metric is nullable, and null means the
 *    provider did not report it -- never zero. `unavailable` carries the reason
 *    verbatim, so a UI can say "Groq does not expose usage" rather than drawing
 *    a flat line at zero. A row is written only when a provider actually
 *    reported something; collection alone creates no rows.
 *
 * 2. **A window is corrected, not duplicated.** The collector re-requests an
 *    overlapping window on every run because providers finalise usage late, so
 *    `(api_key_id, timestamp, window_end)` is unique and writes upsert.
 */
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: primaryId(),

    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),

    /**
     * Restricted, matching `api_keys`: removing a provider from the catalogue
     * must not silently erase an organization's spend history.
     */
    providerId: uuid('provider_id')
      .notNull()
      .references(() => aiProviders.id, { onDelete: 'restrict' }),

    /**
     * The credential the usage is attributed to. Required: a usage row that
     * cannot be traced to a key cannot be traced to a project either, and
     * unattributable cost is the thing this table exists to prevent. Rows the
     * collector cannot attribute are dropped with a reason rather than parked
     * against whichever credential happened to fetch them.
     */
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),

    /**
     * Start of the interval this row covers -- the build plan's `timestamp`.
     *
     * The provider chooses the interval (OpenAI and Anthropic report daily
     * buckets, Deepgram reports whatever its resolution returns), so it is
     * stored as the provider gave it rather than re-bucketed on the way in.
     * Re-bucketing would make the stored numbers unverifiable against the
     * provider's own dashboard.
     */
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),

    /** End of the interval. Together with `timestamp` it identifies the bucket. */
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),

    /** Requests the provider counted in this interval. */
    requests: integer('requests'),
    successfulRequests: integer('successful_requests'),
    failedRequests: integer('failed_requests'),

    /**
     * `bigint` rather than `integer`: a busy organization passes 2.1 billion
     * tokens in a single day, and an overflow here would be silent data loss.
     * Mode `number` keeps them ordinary JS numbers, exact to 2^53.
     */
    inputTokens: bigint('input_tokens', { mode: 'number' }),
    outputTokens: bigint('output_tokens', { mode: 'number' }),
    totalTokens: bigint('total_tokens', { mode: 'number' }),

    /**
     * Speech providers meter characters and audio, not tokens. Beyond the
     * build plan's column list, but ElevenLabs and Deepgram would otherwise
     * store rows in which every metric is null.
     */
    characters: bigint('characters', { mode: 'number' }),
    audioSeconds: bigint('audio_seconds', { mode: 'number' }),

    /**
     * Cost in USD **as reported by the provider**, never derived from a local
     * price list.
     *
     * `numeric` rather than a float: money summed over thousands of rows must
     * not accumulate binary rounding error. Eight decimal places because
     * per-request costs are quoted in fractions of a cent.
     */
    estimatedCost: numeric('estimated_cost', { precision: 20, scale: 8, mode: 'number' }),

    /**
     * Errors the provider attributed to this interval.
     *
     * Distinct from `failed_requests`, which counts requests that ran and
     * failed; some providers also report errors rejected before execution. No
     * adapter reports this yet, so it stays null with a reason -- the column
     * exists because the plan specifies it, and a provider that starts
     * reporting it needs no migration.
     */
    errorCount: integer('error_count'),

    /** Requests rejected for rate limiting (HTTP 429) in this interval. */
    rateLimitCount: integer('rate_limit_count'),

    /**
     * Round-trip latency, in milliseconds, of the collection that produced this
     * row -- our observation of the provider, not a figure the provider
     * reported about its own serving. Named for the plan's `latency`; a
     * provider that reports true per-request latency would need a separate
     * column rather than overloading this one.
     */
    latencyMs: integer('latency_ms'),

    /**
     * The provider's own identifier for the key this usage was billed to.
     *
     * Kept because org-wide usage endpoints group by it: it is the evidence
     * behind the attribution, and without it a mis-mapped key could not be
     * traced back.
     */
    providerKeyId: text('provider_key_id'),

    /**
     * Why a metric is null, keyed by column name.
     *
     * The whole point of the provider layer's `Metric` type is that
     * "unavailable" carries a reason; discarding it at the storage boundary
     * would leave the UI unable to tell "the provider has no such API" from
     * "the call failed".
     */
    unavailable: jsonb('unavailable').$type<Record<string, { reason: string; detail: string }>>(),

    /**
     * Provider-specific fields preserved verbatim (per-model splits, cached
     * tokens, endpoints). Normalization necessarily loses detail; keeping the
     * original means a later phase can use it without re-collecting a window
     * the provider may no longer serve.
     */
    providerRaw: jsonb('provider_raw').$type<Record<string, unknown>>(),

    ...timestamps,
  },
  (table) => [
    /**
     * Organization isolation enforced by the database, as everywhere else:
     * (organization_id, project_id) against the unique key on `projects` makes
     * a usage row for another organization's project impossible to write.
     */
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: 'ai_usage_org_project_fk',
    }).onDelete('cascade'),

    /**
     * The upsert target. Re-collecting an overlapping window must correct the
     * interval, not append a second copy of it.
     */
    unique('ai_usage_key_window_unique').on(table.apiKeyId, table.timestamp, table.windowEnd),

    /**
     * Aggregation indexes, leading with the tenant and ending with time so a
     * range scan reads exactly the rows a dashboard asks for. Ascending is
     * enough -- Postgres scans an index backwards for `order by desc`.
     */
    index('ai_usage_org_time_idx').on(table.organizationId, table.timestamp),
    index('ai_usage_org_project_time_idx').on(
      table.organizationId,
      table.projectId,
      table.timestamp
    ),
    index('ai_usage_org_provider_time_idx').on(
      table.organizationId,
      table.providerId,
      table.timestamp
    ),
    index('ai_usage_key_time_idx').on(table.apiKeyId, table.timestamp),
  ]
);

export type AiUsageRow = typeof aiUsage.$inferSelect;
export type NewAiUsageRow = typeof aiUsage.$inferInsert;
