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
 * Providers with an implemented adapter.
 *
 * Covers both LLM inference and speech services -- what they have in common is
 * that they are metered third-party APIs behind a credential. Which metrics
 * each one actually exposes differs enormously and is declared per adapter in
 * `src/lib/providers`, never assumed here.
 *
 * Adding a value requires `ALTER TYPE ... ADD VALUE`, which drizzle-kit
 * generates. A new value cannot be *used* in the same transaction that adds it,
 * which is why the catalogue seed lives in a separate migration file.
 */
export const aiProviderTypeEnum = pgEnum('ai_provider_type', [
  'openai',
  'google_gemini',
  'anthropic',
  'groq',
  'qwen',
  'elevenlabs',
  'deepgram',
  'openrouter',
  'deepseek',
  'mistral',
  'azure_openai',
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

/**
 * A member's role within one organization.
 *
 * Roles are per-membership rather than per-user: the same person may
 * administer one organization and only read another. See `permissions.ts` for
 * what each role may actually do.
 */
export const orgRoleEnum = pgEnum('org_role', ['org_admin', 'developer']);

/**
 * Outcome of checking a credential against its provider.
 *
 * `unverified` is distinct from `invalid`: the provider could not be reached or
 * was rate limiting, so nothing was learned about the key. Treating that as
 * invalid would reject a good key during a provider outage.
 */
export const credentialValidationOutcomeEnum = pgEnum('credential_validation_outcome', [
  'valid',
  'invalid',
  'unverified',
]);
