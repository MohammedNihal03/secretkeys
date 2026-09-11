import { and, eq, sql } from 'drizzle-orm';

import { getDb } from '@/lib/db/client';
import { getConstraintName, getSqlState, PG_ERROR } from '@/lib/db/errors';
import { aiProviders, apiKeys, projects } from '@/lib/db/schema';
import { parseAzureEndpoint } from '@/lib/providers/azure-openai';
import { getAdapter } from '@/lib/providers/registry';
import { isProviderEnabled } from '@/lib/providers/selection';
import type { AiProviderType, ProviderCredential } from '@/lib/providers/types';
import {
  CredentialDecryptionError,
  decryptSecret,
  encryptionConfigurationError,
  encryptSecret,
  fingerprintSecret,
} from './crypto';
import { secretSuffix } from './mask';
import { redactSecret } from './redact';
import { needsEndpoint } from './requirements';
import type {
  ApiKeyMetadataValues,
  MetadataFieldErrors,
  RegisterApiKeyValues,
  RegisterFieldErrors,
} from './schema';
import type { ApiKeyStatus } from './status';
import { classifyValidation, type ValidationOutcome } from './validation-outcome';

/**
 * Registering, checking and using provider credentials.
 *
 * The registration flow follows the build plan exactly:
 *
 *   1. validate the provider       (exists, and this organization tracks it)
 *   2. validate the credential     (against the provider, where supported)
 *   3. encrypt it                  (AES-256-GCM, bound to the organization)
 *   4. store the metadata          (project, environment, discovered ids)
 *   5. store the last characters   (for identification only)
 *   6. never return the secret     (nothing here returns or logs it)
 *
 * SECURITY: the plaintext secret only ever exists in function arguments. It is
 * never returned, never logged, and any provider message that might echo it is
 * redacted before being stored or shown.
 */

const API_KEY_PURPOSE = 'api_key' as const;

export type RegisterResult =
  | {
      ok: true;
      apiKeyId: string;
      outcome: Exclude<ValidationOutcome, 'invalid'>;
      detail: string | null;
    }
  | { ok: false; errors: RegisterFieldErrors }
  | { ok: false; error: string };

/** Validates a per-provider endpoint. Only providers that need one accept one. */
function resolveEndpoint(
  type: AiProviderType,
  providerName: string,
  raw: string | null
): { ok: true; baseUrl: string | null } | { ok: false; error: string } {
  if (!needsEndpoint(type)) return { ok: true, baseUrl: null };

  if (!raw) return { ok: false, error: `${providerName} needs its resource endpoint.` };

  const parsed = parseAzureEndpoint(raw);
  return parsed.ok ? { ok: true, baseUrl: parsed.baseUrl } : { ok: false, error: parsed.error };
}

/**
 * Rethrows a database failure without its payload.
 *
 * Drizzle's error message includes the query parameters, which here means the
 * ciphertext and fingerprint. Neither is the plaintext, but neither belongs in
 * a log line either, so only the SQLSTATE survives.
 */
function opaqueDatabaseError(action: string, error: unknown): Error {
  return new Error(`${action} failed (SQLSTATE ${getSqlState(error) ?? 'unknown'}).`);
}

export async function registerApiKey(
  organizationId: string,
  input: RegisterApiKeyValues
): Promise<RegisterResult> {
  // Checked first, so nothing is sent to a provider for a key that cannot be stored.
  const configurationError = encryptionConfigurationError();
  if (configurationError) return { ok: false, error: configurationError };

  const db = getDb();

  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.organizationId, organizationId), eq(projects.id, input.projectId)))
    .limit(1);

  if (!project) {
    return { ok: false, errors: { projectId: 'Choose a project in this organization.' } };
  }

  // 1. The provider exists, and this organization tracks it.
  const [provider] = await db
    .select({ id: aiProviders.id, type: aiProviders.type, name: aiProviders.name })
    .from(aiProviders)
    .where(eq(aiProviders.id, input.providerId))
    .limit(1);

  if (!provider) return { ok: false, errors: { providerId: 'Choose a provider.' } };

  if (!(await isProviderEnabled(organizationId, provider.type))) {
    return {
      ok: false,
      errors: {
        providerId: `${provider.name} is not tracked by this organization. Switch it on under Providers first.`,
      },
    };
  }

  /**
   * An endpoint arriving with a provider that does not use one means the form
   * and the chosen provider disagree -- which is how, in testing, a key entered
   * for Azure OpenAI ended up saved against Anthropic and later checked there.
   * Refusing before any request means a key is never sent to a provider the
   * user did not pick.
   */
  if (!needsEndpoint(provider.type) && input.baseUrl) {
    return {
      ok: false,
      errors: {
        providerId: `${provider.name} does not use a resource endpoint. Check that the right provider is selected.`,
      },
    };
  }

  const endpoint = resolveEndpoint(provider.type, provider.name, input.baseUrl);
  if (!endpoint.ok) return { ok: false, errors: { baseUrl: endpoint.error } };

  /**
   * Duplicate check before contacting the provider: registering the same key
   * twice should say so immediately, not after a network round trip -- and it
   * spares the provider a pointless request.
   */
  const fingerprint = fingerprintSecret(input.secret, organizationId);

  const [duplicate] = await db
    .select({ keyName: apiKeys.keyName })
    .from(apiKeys)
    .where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.keyFingerprint, fingerprint)))
    .limit(1);

  if (duplicate) {
    return {
      ok: false,
      errors: { secret: `This key is already registered as “${duplicate.keyName}”.` },
    };
  }

  // 2. The credential works, where the provider lets us check.
  const validation = await getAdapter(provider.type).validateCredentials({
    apiKey: input.secret,
    baseUrl: endpoint.baseUrl,
  });

  const detail = redactSecret(validation.detail, input.secret) ?? null;
  const verdict = classifyValidation(validation);

  if (verdict.outcome === 'invalid') {
    const message = `${provider.name} rejected this key${detail ? ` — ${detail}` : '.'}`;
    return {
      ok: false,
      errors: verdict.field === 'baseUrl' ? { baseUrl: detail ?? message } : { secret: message },
    };
  }

  try {
    const [row] = await db
      .insert(apiKeys)
      .values({
        organizationId,
        projectId: project.id,
        providerId: provider.id,
        keyName: input.keyName,
        environment: input.environment,
        // 3. Encrypted, bound to this organization.
        encryptedKey: encryptSecret(input.secret, { organizationId, purpose: API_KEY_PURPOSE }),
        keyFingerprint: fingerprint,
        // 5. Only the trailing characters, for identification.
        keyLast4: secretSuffix(input.secret),
        // 4. Metadata, including anything the provider revealed while validating.
        baseUrl: endpoint.baseUrl,
        providerKeyId: input.providerKeyId ?? validation.discovered?.providerKeyId ?? null,
        providerProjectId: validation.discovered?.providerProjectId ?? null,
        status: 'active',
        // The database clock, consistent with created_at.
        lastValidatedAt: sql`now()`,
        lastValidationOutcome: verdict.outcome,
        lastValidationDetail: detail,
      })
      .returning({ id: apiKeys.id });

    // 6. Only the id and the outcome leave this function.
    return { ok: true, apiKeyId: row.id, outcome: verdict.outcome, detail };
  } catch (error) {
    if (getSqlState(error) === PG_ERROR.uniqueViolation) {
      const constraint = getConstraintName(error);

      if (constraint === 'api_keys_org_key_name_unique') {
        return { ok: false, errors: { keyName: 'A key with this name already exists.' } };
      }

      // A concurrent registration of the same key won the race.
      if (constraint === 'api_keys_org_fingerprint_unique') {
        return { ok: false, errors: { secret: 'This key is already registered.' } };
      }
    }

    if (getSqlState(error) === PG_ERROR.foreignKeyViolation) {
      return { ok: false, errors: { projectId: 'That project no longer exists.' } };
    }

    throw opaqueDatabaseError('Saving the API key', error);
  }
}

export type RevalidateResult =
  { ok: true; outcome: ValidationOutcome; detail: string | null } | { ok: false; error: string };

/** Checks a stored key against its provider again and records the result. */
export async function revalidateApiKey(
  organizationId: string,
  apiKeyId: string
): Promise<RevalidateResult> {
  const configurationError = encryptionConfigurationError();
  if (configurationError) return { ok: false, error: configurationError };

  const loaded = await loadCredentialForUse(organizationId, apiKeyId);
  if (!loaded) return { ok: false, error: 'This key no longer exists.' };
  if ('error' in loaded) return { ok: false, error: loaded.error };

  if (loaded.status === 'revoked') {
    return { ok: false, error: 'A revoked key cannot be checked.' };
  }

  const validation = await getAdapter(loaded.providerType).validateCredentials(loaded.credential);
  const detail = redactSecret(validation.detail, loaded.credential.apiKey) ?? null;
  const { outcome } = classifyValidation(validation);

  await getDb()
    .update(apiKeys)
    .set({
      lastValidatedAt: sql`now()`,
      lastValidationOutcome: outcome,
      lastValidationDetail: detail,
      // Fill in a provider-side id discovered now, without overwriting one set by hand.
      ...(validation.discovered?.providerProjectId
        ? {
            providerProjectId: sql`coalesce(${apiKeys.providerProjectId}, ${validation.discovered.providerProjectId})`,
          }
        : {}),
    })
    .where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.id, apiKeyId)));

  return { ok: true, outcome, detail };
}

export type UpdateMetadataResult =
  { ok: true } | { ok: false; errors: MetadataFieldErrors } | { ok: false; error: string };

export async function updateApiKeyMetadata(
  organizationId: string,
  apiKeyId: string,
  values: ApiKeyMetadataValues
): Promise<UpdateMetadataResult> {
  try {
    const updated = await getDb()
      .update(apiKeys)
      .set(values)
      .where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.id, apiKeyId)))
      .returning({ id: apiKeys.id });

    return updated.length > 0 ? { ok: true } : { ok: false, error: 'This key no longer exists.' };
  } catch (error) {
    if (
      getSqlState(error) === PG_ERROR.uniqueViolation &&
      getConstraintName(error) === 'api_keys_org_key_name_unique'
    ) {
      return { ok: false, errors: { keyName: 'A key with this name already exists.' } };
    }

    throw opaqueDatabaseError('Updating the API key', error);
  }
}

export type StatusChangeResult = { ok: true } | { ok: false; error: string };

/**
 * Changes a key's lifecycle state.
 *
 * Revocation is terminal. A revoked key is kept rather than deleted, so usage
 * already attributed to it keeps its project -- but it can never become active
 * again. Reinstating a credential that was revoked because it leaked would
 * silently undo the response to the leak.
 */
export async function setApiKeyStatus(
  organizationId: string,
  apiKeyId: string,
  next: ApiKeyStatus
): Promise<StatusChangeResult> {
  const db = getDb();

  const [current] = await db
    .select({ status: apiKeys.status })
    .from(apiKeys)
    .where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.id, apiKeyId)))
    .limit(1);

  if (!current) return { ok: false, error: 'This key no longer exists.' };

  if (current.status === 'revoked') {
    return {
      ok: false,
      error: 'This key has been revoked. Revocation is permanent — register a new key instead.',
    };
  }

  await db
    .update(apiKeys)
    .set({ status: next })
    .where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.id, apiKeyId)));

  return { ok: true };
}

export interface CredentialForUse {
  providerType: AiProviderType;
  status: ApiKeyStatus;
  credential: ProviderCredential;
}

/**
 * Decrypts a stored key for immediate use by a collector or a check.
 *
 * SECURITY: server-only, and the result must never be returned from a route or
 * a Server Action. It exists for code that calls the provider and discards the
 * secret straight afterwards.
 */
export async function loadCredentialForUse(
  organizationId: string,
  apiKeyId: string
): Promise<CredentialForUse | { error: string } | null> {
  const [row] = await getDb()
    .select({
      encryptedKey: apiKeys.encryptedKey,
      baseUrl: apiKeys.baseUrl,
      providerProjectId: apiKeys.providerProjectId,
      status: apiKeys.status,
      providerType: aiProviders.type,
    })
    .from(apiKeys)
    .innerJoin(aiProviders, eq(apiKeys.providerId, aiProviders.id))
    .where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.id, apiKeyId)))
    .limit(1);

  if (!row) return null;

  try {
    return {
      providerType: row.providerType,
      status: row.status,
      credential: {
        apiKey: decryptSecret(row.encryptedKey, { organizationId, purpose: API_KEY_PURPOSE }),
        baseUrl: row.baseUrl,
        providerProjectId: row.providerProjectId,
      },
    };
  } catch (error) {
    if (error instanceof CredentialDecryptionError) return { error: error.message };
    throw error;
  }
}
