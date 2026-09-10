import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Shared enumerations.
 *
 * Postgres enums are used rather than free text so a typo cannot create a
 * fourth environment or an unrecognised provider. New values are added with
 * `ALTER TYPE ... ADD VALUE`, which drizzle-kit generates.
 */

/**
 * Deployment environment a resource belongs to.
 *
 * The same provider is typically used from several environments with separate
 * keys, so this is what separates "FYIND Production" from "FYIND Staging".
 */
export const environmentEnum = pgEnum('environment', ['production', 'staging', 'development']);

/**
 * AI providers with an implemented adapter.
 *
 * Extended in Phase 3 as adapters are added; the MVP targets these three.
 */
export const aiProviderTypeEnum = pgEnum('ai_provider_type', [
  'openai',
  'google_gemini',
  'anthropic',
]);

/**
 * Whether a resource is in use.
 *
 * This is a *configuration* state set by an administrator. It is NOT health --
 * health is derived from collected metrics by the Phase 9 evaluation engine and
 * is never stored on these tables.
 */
export const resourceStatusEnum = pgEnum('resource_status', ['active', 'disabled']);

/**
 * Lifecycle of a registered credential.
 *
 * `disabled` is reversible (an admin paused collection). `revoked` is terminal:
 * the credential is dead at the provider, so it must never be retried, but the
 * row is retained because historical usage still references it.
 */
export const apiKeyStatusEnum = pgEnum('api_key_status', ['active', 'disabled', 'revoked']);

/** Engine of a monitored database. The MVP implements a PostgreSQL collector only. */
export const databaseTypeEnum = pgEnum('database_type', ['postgresql']);
