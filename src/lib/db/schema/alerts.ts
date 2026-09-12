import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { primaryId, timestamps } from './columns';
import { alertSeverityEnum, alertStatusEnum, resourceTypeEnum } from './enums';
import { organizations } from './organizations';
import { projects } from './projects';

/**
 * In-dashboard alerts.
 *
 * An alert is a *condition that is currently true*, not an event that happened.
 * That distinction is what the build plan means by "avoid duplicate alerts for
 * the same ongoing condition": a connection pool that sits above its threshold
 * for six hours is one alert that has been open for six hours, not three
 * hundred and sixty alerts.
 *
 * The identity of a condition is `(organization, resource, rule)`, and the
 * partial unique index below is what enforces one open alert per condition --
 * in the database, not in the code that writes them. Two collectors running at
 * once cannot produce a duplicate; the second insert is rejected.
 *
 * Resolution is a state change on the same row, so the history of a condition
 * stays in one place: when it started, how bad it got, and when it cleared.
 */
export const alerts = pgTable(
  'alerts',
  {
    id: primaryId(),

    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    /**
     * Nullable: a provider-level condition belongs to the organization rather
     * than to any one project, and forcing a project onto it would make the
     * attribution a lie.
     */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),

    resourceType: resourceTypeEnum('resource_type').notNull(),

    /**
     * The api key or monitored database this is about. Deliberately not a
     * foreign key: an alert should survive the deletion of what it was about,
     * so "why did we take that key away" still has an answer afterwards. The
     * cascade from `organization_id` still cleans up a deleted tenant.
     */
    resourceId: uuid('resource_id').notNull(),
    /** The resource's name when the alert was raised, for display after deletion. */
    resourceName: text('resource_name').notNull(),

    /**
     * Which rule raised it, e.g. `connections.utilizationPercent`. Part of the
     * condition's identity, so two different problems on one database are two
     * alerts rather than one that keeps changing its mind.
     */
    rule: text('rule').notNull(),

    severity: alertSeverityEnum('severity').notNull(),
    status: alertStatusEnum('status').notNull().default('active'),

    /** One line, already written for a human. */
    title: text('title').notNull(),
    /** The detail, including the threshold and why it exists. */
    description: text('description').notNull(),

    triggeredAt: timestamp('triggered_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),

    /**
     * When the condition was last seen to still be true. Distinct from
     * `updated_at`, which moves for any write: this moves only when a
     * collection re-observed the problem, so a stale alert is detectable.
     */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * The worst severity reached while open. A condition that escalated from
     * warning to critical and back should not look like it was only ever a
     * warning once it resolves.
     */
    peakSeverity: alertSeverityEnum('peak_severity').notNull(),

    ...timestamps,
  },
  (table) => [
    /**
     * One open alert per condition, enforced by the database.
     *
     * Partial, on `status = 'active'`: a resolved alert must not block the same
     * condition from being raised again next week, which is exactly what a
     * plain unique index would do.
     */
    uniqueIndex('alerts_active_condition_unique')
      .on(table.organizationId, table.resourceType, table.resourceId, table.rule)
      .where(sql`${table.status} = 'active'`),

    // The alerts page: this organization's, newest first.
    index('alerts_org_status_idx').on(table.organizationId, table.status, table.triggeredAt),

    // One resource's history, for its detail page.
    index('alerts_resource_idx').on(table.resourceId, table.triggeredAt),
  ]
);

export type Alert = typeof alerts.$inferSelect;
export type NewAlert = typeof alerts.$inferInsert;
