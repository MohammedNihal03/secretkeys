import { and, asc, eq, isNull, or } from 'drizzle-orm';

import { getDb } from '@/lib/db/client';
import {
  aiProviders,
  apiKeys,
  organizationProviders,
  organizations,
  projects,
} from '@/lib/db/schema';
import type { CollectionTarget } from './types';

/**
 * Which credentials to collect from.
 *
 * Four things exclude a credential, and each is a deliberate choice by someone:
 *
 *   - the key is disabled or revoked          (an administrator paused it)
 *   - the organization does not track the provider (the Phase 3 selection)
 *   - the provider is disabled in the catalogue    (the adapter is withdrawn)
 *
 * Absent selection rows mean tracked, matching `resolveProviderSelection`, so a
 * newly shipped adapter is collected for existing organizations rather than
 * silently skipped.
 */
export async function listCollectionTargets(organizationId?: string): Promise<CollectionTarget[]> {
  return (
    getDb()
      .select({
        organizationId: apiKeys.organizationId,
        organizationName: organizations.name,
        projectId: projects.id,
        projectName: projects.name,
        providerId: aiProviders.id,
        providerType: aiProviders.type,
        providerName: aiProviders.name,
        apiKeyId: apiKeys.id,
        keyName: apiKeys.keyName,
        environment: apiKeys.environment,
      })
      .from(apiKeys)
      .innerJoin(projects, eq(apiKeys.projectId, projects.id))
      .innerJoin(aiProviders, eq(apiKeys.providerId, aiProviders.id))
      .innerJoin(organizations, eq(apiKeys.organizationId, organizations.id))
      /**
       * Left join, not inner: a provider nobody has expressed an opinion about
       * has no row here, and must still be collected.
       */
      .leftJoin(
        organizationProviders,
        and(
          eq(organizationProviders.organizationId, apiKeys.organizationId),
          eq(organizationProviders.providerId, apiKeys.providerId)
        )
      )
      .where(
        and(
          eq(apiKeys.status, 'active'),
          eq(aiProviders.status, 'active'),
          or(isNull(organizationProviders.enabled), eq(organizationProviders.enabled, true)),
          // `and` ignores undefined, so this narrows only when asked to.
          organizationId ? eq(apiKeys.organizationId, organizationId) : undefined
        )
      )
      /**
       * Grouped by provider first: the runner collects each provider's
       * credentials in sequence, so ordering this way keeps one provider's work
       * together instead of interleaving requests to all of them at once.
       */
      .orderBy(asc(aiProviders.type), asc(organizations.name), asc(apiKeys.keyName))
  );
}
