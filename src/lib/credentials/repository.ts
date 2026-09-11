import { and, asc, eq } from 'drizzle-orm';

import { getDb } from '@/lib/db/client';
import { aiProviders, apiKeys, projects } from '@/lib/db/schema';
import type { Environment } from '@/lib/projects/schema';
import type { AiProviderType } from '@/lib/providers/types';
import type { ApiKeyStatus, ValidationOutcomeValue } from './status';

/**
 * Display-safe reads of registered API keys.
 *
 * SECURITY: every query here names its columns explicitly and none of them is
 * `encrypted_key` or `key_fingerprint`. There is no `select()` of the whole row
 * anywhere in this file, so ciphertext cannot reach a page by accident -- not
 * even as a field the UI simply ignores. Decryption lives in `service.ts`.
 *
 * Every function takes `organizationId` and filters on it.
 */

export interface ApiKeyView {
  id: string;
  keyName: string;
  keyLast4: string;
  environment: Environment;
  status: ApiKeyStatus;
  baseUrl: string | null;
  providerKeyId: string | null;
  providerProjectId: string | null;
  lastValidatedAt: Date | null;
  lastValidationOutcome: ValidationOutcomeValue | null;
  lastValidationDetail: string | null;
  createdAt: Date;
  updatedAt: Date;
  project: { id: string; name: string };
  provider: { id: string; type: AiProviderType; name: string };
}

const SAFE_COLUMNS = {
  id: apiKeys.id,
  keyName: apiKeys.keyName,
  keyLast4: apiKeys.keyLast4,
  environment: apiKeys.environment,
  status: apiKeys.status,
  baseUrl: apiKeys.baseUrl,
  providerKeyId: apiKeys.providerKeyId,
  providerProjectId: apiKeys.providerProjectId,
  lastValidatedAt: apiKeys.lastValidatedAt,
  lastValidationOutcome: apiKeys.lastValidationOutcome,
  lastValidationDetail: apiKeys.lastValidationDetail,
  createdAt: apiKeys.createdAt,
  updatedAt: apiKeys.updatedAt,
  project: { id: projects.id, name: projects.name },
  provider: { id: aiProviders.id, type: aiProviders.type, name: aiProviders.name },
};

function baseQuery() {
  return getDb()
    .select(SAFE_COLUMNS)
    .from(apiKeys)
    .innerJoin(projects, eq(apiKeys.projectId, projects.id))
    .innerJoin(aiProviders, eq(apiKeys.providerId, aiProviders.id));
}

/** Keys for an organization, optionally narrowed to one project. */
export async function listApiKeys(
  organizationId: string,
  options: { projectId?: string } = {}
): Promise<ApiKeyView[]> {
  const scope = options.projectId
    ? and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.projectId, options.projectId))
    : eq(apiKeys.organizationId, organizationId);

  return baseQuery()
    .where(scope)
    .orderBy(asc(projects.name), asc(aiProviders.name), asc(apiKeys.keyName));
}

export async function getApiKey(
  organizationId: string,
  apiKeyId: string
): Promise<ApiKeyView | null> {
  const [row] = await baseQuery()
    // Both predicates: an id alone would reach another tenant's key.
    .where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.id, apiKeyId)))
    .limit(1);

  return row ?? null;
}
