import { pgTable, text, unique } from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from './columns';
import { aiProviderTypeEnum, resourceStatusEnum } from './enums';

/**
 * Catalogue of supported AI providers.
 *
 * Deliberately NOT tenant-scoped: per the data model, a provider is a global
 * reference row describing an adapter the dashboard knows how to talk to
 * ("OpenAI", "Anthropic"). Tenant-owned data is the *credential*, which lives
 * in `api_keys` and points here.
 *
 * The rows are seeded by migration so `api_keys.provider_id` always resolves.
 */
export const aiProviders = pgTable(
  'ai_providers',
  {
    id: primaryId(),

    /** Human-readable label shown in the UI, e.g. "Google Gemini". */
    name: text('name').notNull(),

    /** Selects the adapter implementation. */
    type: aiProviderTypeEnum('type').notNull(),

    /** Whether the dashboard should collect from this provider at all. Not health. */
    status: resourceStatusEnum('status').notNull().default('active'),
    ...timestamps,
  },
  (table) => [
    // One catalogue row per adapter type.
    unique('ai_providers_type_unique').on(table.type),
  ]
);

export type AiProvider = typeof aiProviders.$inferSelect;
export type NewAiProvider = typeof aiProviders.$inferInsert;
