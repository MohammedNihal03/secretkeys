import { foreignKey, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from './columns';
import { apiKeyStatusEnum, environmentEnum } from './enums';
import { aiProviders } from './ai-providers';
import { organizations } from './organizations';
import { projects } from './projects';

/**
 * A registered AI provider credential, explicitly bound to the project and
 * environment that uses it.
 *
 * The project association is recorded by an administrator and is never inferred
 * from the key itself -- a provider key carries no reliable signal about which
 * of our projects uses it. This table is what makes the
 * `project -> provider -> key -> usage` chain resolvable, which is the whole
 * basis for per-project cost attribution.
 *
 * SECURITY: `encryptedKey` is ciphertext and must never be selected into a
 * response. The UI identifies a credential by `keyName` and `keyLast4` only.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: primaryId(),

    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    /**
     * Owning project. Required: a credential with no project cannot be
     * attributed, which would defeat the point of collecting its usage.
     */
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),

    /**
     * Restricted rather than cascaded: removing a provider from the catalogue
     * must not silently delete an organization's credentials and their usage
     * history.
     */
    providerId: uuid('provider_id')
      .notNull()
      .references(() => aiProviders.id, { onDelete: 'restrict' }),

    /** Operator-chosen label, e.g. "FYIND Production". */
    keyName: text('key_name').notNull(),

    /** Ciphertext. Written and read only by the credential layer (Phase 4). */
    encryptedKey: text('encrypted_key').notNull(),

    /** Trailing characters, for identifying a key in the UI without revealing it. */
    keyLast4: text('key_last4').notNull(),

    /**
     * Deterministic HMAC of the secret, used only for equality.
     *
     * Encryption is randomised, so ciphertext cannot detect duplicates. Without
     * this, the same physical key could be registered under two projects and
     * both would be credited the full usage -- making per-project cost silently
     * wrong. Nullable here; populated by the credential layer in Phase 4.
     */
    keyFingerprint: text('key_fingerprint'),

    /**
     * The provider's own project/organization identifier where it exposes one
     * (e.g. OpenAI `proj_...`). Kept separate from our `projectId` so provider-
     * side grouping and our attribution are never confused for one another.
     */
    providerProjectId: text('provider_project_id'),

    /**
     * The provider's own identifier for this credential (e.g. OpenAI
     * `key_abc123`, a Deepgram key id).
     *
     * Required to attribute org-wide usage back to a project. OpenAI and
     * Anthropic only expose usage through an *organization admin* credential,
     * returning rows grouped by their own key id -- so without this column
     * there is no way to join their reported usage to one of our projects.
     * Nullable: not every provider exposes such an id.
     */
    providerKeyId: text('provider_key_id'),

    /** Environment this credential serves. Authoritative for usage attribution. */
    environment: environmentEnum('environment').notNull(),

    status: apiKeyStatusEnum('status').notNull().default('active'),
    ...timestamps,
  },
  (table) => [
    /**
     * Organization isolation enforced by the database, not by query discipline.
     *
     * Pairing (organization_id, project_id) against the matching unique key on
     * `projects` makes it impossible to attach a credential to a project owned
     * by a different organization -- even via a buggy insert or a raw SQL
     * statement. The same pattern guards `monitored_databases`.
     */
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: 'api_keys_org_project_fk',
    }).onDelete('cascade'),

    // Key names must be unambiguous within an organization.
    unique('api_keys_org_key_name_unique').on(table.organizationId, table.keyName),

    // The same secret must not be registered twice in one organization.
    unique('api_keys_org_fingerprint_unique').on(table.organizationId, table.keyFingerprint),

    index('api_keys_org_idx').on(table.organizationId),
    index('api_keys_project_idx').on(table.projectId),
    index('api_keys_provider_idx').on(table.providerId),

    // The collector's working set: active credentials to sample next.
    index('api_keys_status_idx').on(table.status),
  ]
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;

/**
 * An API key with every secret-bearing column removed.
 *
 * Use this as the return type for anything that reaches a client, so omitting
 * the ciphertext is enforced by the compiler rather than remembered.
 */
export type SafeApiKey = Omit<ApiKey, 'encryptedKey' | 'keyFingerprint'>;
