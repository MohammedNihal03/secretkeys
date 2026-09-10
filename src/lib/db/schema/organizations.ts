import { pgTable, text, unique } from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from './columns';

/**
 * Top of the tenancy hierarchy. Every tenant-owned row carries an
 * `organization_id`, and cross-organization references are blocked by
 * composite foreign keys rather than by application code alone.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: primaryId(),
    name: text('name').notNull(),
    ...timestamps,
  },
  (table) => [unique('organizations_name_unique').on(table.name)]
);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
