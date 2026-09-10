import { boolean, index, pgTable, unique, uuid } from 'drizzle-orm/pg-core';

import { aiProviders } from './ai-providers';
import { primaryId, timestamps } from './columns';
import { organizations } from './organizations';

/**
 * Which providers an organization has chosen to track.
 *
 * The `ai_providers` catalogue is global -- it describes which adapters exist in
 * code. This table is the per-organization *selection* on top of it, so a
 * company using only OpenAI and ElevenLabs is not shown five services it does
 * not use, while one that wants everything can keep everything.
 *
 * ABSENT ROW MEANS ENABLED. The row records a deliberate choice, so a provider
 * nobody has touched stays visible. That matters when a new adapter ships: it
 * appears for existing organizations rather than being silently withheld, and
 * in a monitoring tool a silent omission is worse than a visible service you
 * can switch off in one click. `resolveProviderSelection` applies this default.
 */
export const organizationProviders = pgTable(
  'organization_providers',
  {
    id: primaryId(),

    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    /**
     * Cascades, unlike `api_keys.provider_id` which restricts. A selection row
     * carries no history worth protecting -- if a catalogue entry ever went
     * away, the preference about it would be meaningless.
     */
    providerId: uuid('provider_id')
      .notNull()
      .references(() => aiProviders.id, { onDelete: 'cascade' }),

    enabled: boolean('enabled').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    /**
     * One choice per provider per organization. Two rows would make the
     * effective state depend on row ordering.
     */
    unique('organization_providers_org_provider_unique').on(table.organizationId, table.providerId),

    index('organization_providers_org_idx').on(table.organizationId),
  ]
);

export type OrganizationProvider = typeof organizationProviders.$inferSelect;
export type NewOrganizationProvider = typeof organizationProviders.$inferInsert;
