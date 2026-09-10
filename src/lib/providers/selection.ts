import { and, eq, inArray } from 'drizzle-orm';

import { getDb } from '@/lib/db/client';
import { aiProviders, organizationProviders } from '@/lib/db/schema';
import { listAdapters } from './registry';
import type { AIProviderAdapter, AiProviderType } from './types';

/**
 * Per-organization provider selection.
 *
 * A company using only OpenAI and ElevenLabs should not be shown five services
 * it does not use; a company that wants all of them should keep all of them.
 * This resolves the stored choice against the adapter registry.
 *
 * The default is **enabled**: a provider nobody has expressed an opinion about
 * stays visible, so a newly shipped adapter appears rather than being silently
 * withheld. See `organization-providers.ts` for the reasoning.
 */

export interface ProviderSelection {
  providerId: string;
  type: AiProviderType;
  displayName: string;
  adapter: AIProviderAdapter;
  enabled: boolean;
  /** True when the organization has explicitly chosen, rather than defaulting. */
  explicit: boolean;
}

/**
 * Merges catalogue rows with stored choices.
 *
 * Pure, so the default-when-absent rule can be tested without a database --
 * that rule is the whole substance of this feature.
 */
export function resolveProviderSelection(
  catalogue: readonly { id: string; type: AiProviderType }[],
  choices: readonly { providerId: string; enabled: boolean }[]
): ProviderSelection[] {
  const chosen = new Map(choices.map((choice) => [choice.providerId, choice.enabled]));
  const adapters = new Map(listAdapters().map((adapter) => [adapter.type, adapter]));

  return catalogue
    .map((row) => {
      const adapter = adapters.get(row.type);
      // A catalogue row with no adapter cannot be monitored, so it is skipped
      // rather than offered as a choice that would do nothing.
      if (!adapter) return null;

      const stored = chosen.get(row.id);

      return {
        providerId: row.id,
        type: row.type,
        displayName: adapter.displayName,
        adapter,
        enabled: stored ?? true,
        explicit: stored !== undefined,
      } satisfies ProviderSelection;
    })
    .filter((entry): entry is ProviderSelection => entry !== null)
    .sort((a, b) => {
      // LLMs before speech, then alphabetical -- matching the registry order.
      if (a.adapter.category !== b.adapter.category) {
        return a.adapter.category === 'llm' ? -1 : 1;
      }
      return a.displayName.localeCompare(b.displayName);
    });
}

/** Every provider with this organization's choice applied. */
export async function listProviderSelection(organizationId: string): Promise<ProviderSelection[]> {
  const db = getDb();

  const [catalogue, choices] = await Promise.all([
    db.select({ id: aiProviders.id, type: aiProviders.type }).from(aiProviders),
    db
      .select({
        providerId: organizationProviders.providerId,
        enabled: organizationProviders.enabled,
      })
      .from(organizationProviders)
      .where(eq(organizationProviders.organizationId, organizationId)),
  ]);

  return resolveProviderSelection(catalogue, choices);
}

/** Only the providers this organization tracks. Used by collectors and dashboards. */
export async function listEnabledProviders(organizationId: string): Promise<ProviderSelection[]> {
  return (await listProviderSelection(organizationId)).filter((entry) => entry.enabled);
}

/**
 * Records a choice for one provider.
 *
 * Upserted rather than inserted, so toggling the same provider repeatedly does
 * not accumulate rows or race against itself.
 */
export async function setProviderEnabled(
  organizationId: string,
  providerId: string,
  enabled: boolean
): Promise<void> {
  await getDb()
    .insert(organizationProviders)
    .values({ organizationId, providerId, enabled })
    .onConflictDoUpdate({
      target: [organizationProviders.organizationId, organizationProviders.providerId],
      set: { enabled },
    });
}

/**
 * Records the same choice for every provider in the catalogue.
 *
 * Written explicitly for all of them rather than by deleting rows to fall back
 * on the default: "everything on, deliberately" and "nobody has decided yet"
 * are different states, and only the first should survive a new adapter
 * shipping.
 */
export async function setAllProvidersEnabled(
  organizationId: string,
  enabled: boolean
): Promise<void> {
  const db = getDb();
  const catalogue = await db.select({ id: aiProviders.id }).from(aiProviders);

  if (catalogue.length === 0) return;

  await db
    .insert(organizationProviders)
    .values(catalogue.map((row) => ({ organizationId, providerId: row.id, enabled })))
    .onConflictDoUpdate({
      target: [organizationProviders.organizationId, organizationProviders.providerId],
      set: { enabled },
    });
}

/**
 * Whether a provider is tracked by an organization.
 *
 * Takes the provider *type* because callers generally hold that rather than a
 * catalogue id.
 */
export async function isProviderEnabled(
  organizationId: string,
  type: AiProviderType
): Promise<boolean> {
  const db = getDb();

  const [row] = await db
    .select({ enabled: organizationProviders.enabled })
    .from(organizationProviders)
    .innerJoin(aiProviders, eq(organizationProviders.providerId, aiProviders.id))
    .where(
      and(eq(organizationProviders.organizationId, organizationId), eq(aiProviders.type, type))
    )
    .limit(1);

  // Absent means enabled.
  return row?.enabled ?? true;
}

/** Verifies provider ids belong to the catalogue, so a crafted id cannot be stored. */
export async function filterKnownProviderIds(providerIds: readonly string[]): Promise<string[]> {
  if (providerIds.length === 0) return [];

  const rows = await getDb()
    .select({ id: aiProviders.id })
    .from(aiProviders)
    .where(inArray(aiProviders.id, [...providerIds]));

  return rows.map((row) => row.id);
}
