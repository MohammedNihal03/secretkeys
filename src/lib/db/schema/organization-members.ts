import { index, pgTable, unique, uuid } from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from './columns';
import { orgRoleEnum } from './enums';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Membership of a user in an organization, and their role there.
 *
 * This table is the sole source of authority in the application: possessing a
 * session proves *who* you are, and a row here is what proves you may see an
 * organization's data at all. Every organization-scoped query is expected to
 * have been gated by a lookup against this table.
 */
export const organizationMembers = pgTable(
  'organization_members',
  {
    id: primaryId(),

    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    role: orgRoleEnum('role').notNull().default('developer'),
    ...timestamps,
  },
  (table) => [
    /**
     * One membership per user per organization. Without this, a user could hold
     * two rows with different roles and the effective role would depend on row
     * ordering.
     */
    unique('organization_members_org_user_unique').on(table.organizationId, table.userId),

    index('organization_members_org_idx').on(table.organizationId),
    index('organization_members_user_idx').on(table.userId),
  ]
);

export type OrganizationMember = typeof organizationMembers.$inferSelect;
export type NewOrganizationMember = typeof organizationMembers.$inferInsert;
export type OrgRole = OrganizationMember['role'];
