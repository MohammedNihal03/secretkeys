import { index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from './columns';
import { environmentEnum } from './enums';
import { organizations } from './organizations';

/**
 * A unit of work inside an organization -- the thing cost and usage are
 * attributed to. Projects are what make "which project is spending the most on
 * OpenAI?" answerable, since a provider account alone cannot tell you.
 */
export const projects = pgTable(
  'projects',
  {
    id: primaryId(),

    /** Deleting an organization removes its projects, and cascades onward. */
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    description: text('description'),

    /**
     * The project's own environment. Note that usage is attributed by the
     * *API key's* environment, not this column, because one project commonly
     * holds keys for several environments.
     */
    environment: environmentEnum('environment').notNull().default('production'),
    ...timestamps,
  },
  (table) => [
    // Project names are unique per organization, not globally: two tenants may
    // both have a project called "Internal AI".
    unique('projects_org_name_unique').on(table.organizationId, table.name),

    /**
     * Target for the composite foreign keys on `api_keys` and
     * `monitored_databases`. It makes "this project belongs to this
     * organization" a referenceable fact, so a child row cannot pair an
     * organization with a project from a different one.
     */
    unique('projects_org_id_unique').on(table.organizationId, table.id),

    index('projects_org_idx').on(table.organizationId),
  ]
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
