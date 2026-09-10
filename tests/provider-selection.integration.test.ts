import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePool, getDb } from '@/lib/db/client';
import { aiProviders, organizationProviders, organizations } from '@/lib/db/schema';
import {
  filterKnownProviderIds,
  isProviderEnabled,
  listEnabledProviders,
  listProviderSelection,
  setAllProvidersEnabled,
  setProviderEnabled,
} from '@/lib/providers/selection';

/**
 * Provider selection, against a real database.
 *
 *   npm run db:setup && npm run test:integration
 *
 * Covers the two scenarios the feature exists for -- an organization tracking
 * only a couple of providers, and one tracking all of them -- and that one
 * organization's choice never leaks into another's.
 */

const RUN = Math.random().toString(36).slice(2, 10);
const db = getDb();

/** Tracks only OpenAI and ElevenLabs. */
let companyX: string;
/** Tracks everything. */
let companyY: string;
/** Has never touched the setting. */
let untouched: string;

let providerIds: Record<string, string>;

beforeAll(async () => {
  const created = await db
    .insert(organizations)
    .values([
      { name: `Company X ${RUN}` },
      { name: `Company Y ${RUN}` },
      { name: `Untouched ${RUN}` },
    ])
    .returning({ id: organizations.id, name: organizations.name });

  companyX = created.find((row) => row.name.startsWith('Company X'))!.id;
  companyY = created.find((row) => row.name.startsWith('Company Y'))!.id;
  untouched = created.find((row) => row.name.startsWith('Untouched'))!.id;

  const catalogue = await db
    .select({ id: aiProviders.id, type: aiProviders.type })
    .from(aiProviders);
  providerIds = Object.fromEntries(catalogue.map((row) => [row.type, row.id]));
});

afterAll(async () => {
  // Cascades remove the selection rows.
  for (const id of [companyX, companyY, untouched].filter(Boolean)) {
    await db.delete(organizations).where(eq(organizations.id, id));
  }
  await closePool();
});

describe('an organization that has never chosen', () => {
  it('tracks every provider by default', async () => {
    const selection = await listProviderSelection(untouched);

    expect(selection.length).toBeGreaterThanOrEqual(7);
    expect(selection.every((entry) => entry.enabled)).toBe(true);
    expect(selection.every((entry) => !entry.explicit)).toBe(true);
  });

  it('stores no rows until a choice is made', async () => {
    const rows = await db
      .select()
      .from(organizationProviders)
      .where(eq(organizationProviders.organizationId, untouched));

    expect(rows).toHaveLength(0);
  });
});

describe('company X: only OpenAI and ElevenLabs', () => {
  beforeAll(async () => {
    await setAllProvidersEnabled(companyX, false);
    await setProviderEnabled(companyX, providerIds.openai, true);
    await setProviderEnabled(companyX, providerIds.elevenlabs, true);
  });

  it('tracks exactly the two it selected', async () => {
    const enabled = (await listEnabledProviders(companyX)).map((entry) => entry.type).sort();

    expect(enabled).toEqual(['elevenlabs', 'openai']);
  });

  it('reports per-provider state by type', async () => {
    expect(await isProviderEnabled(companyX, 'openai')).toBe(true);
    expect(await isProviderEnabled(companyX, 'google_gemini')).toBe(false);
    expect(await isProviderEnabled(companyX, 'deepgram')).toBe(false);
  });
});

describe('company Y: everything', () => {
  beforeAll(async () => {
    await setAllProvidersEnabled(companyY, true);
  });

  it('tracks every provider, explicitly', async () => {
    const selection = await listProviderSelection(companyY);

    expect(selection.every((entry) => entry.enabled)).toBe(true);
    expect(selection.every((entry) => entry.explicit)).toBe(true);
  });
});

describe('isolation', () => {
  it('keeps one organization choice out of another', async () => {
    // Company X switched Gemini off; that must not affect Y or the untouched org.
    expect(await isProviderEnabled(companyX, 'google_gemini')).toBe(false);
    expect(await isProviderEnabled(companyY, 'google_gemini')).toBe(true);
    expect(await isProviderEnabled(untouched, 'google_gemini')).toBe(true);
  });

  it('changing one organization leaves the others unchanged', async () => {
    const before = (await listEnabledProviders(companyY)).length;

    await setProviderEnabled(companyX, providerIds.groq, true);

    expect((await listEnabledProviders(companyY)).length).toBe(before);
    await setProviderEnabled(companyX, providerIds.groq, false);
  });
});

describe('writes', () => {
  it('upserts, so repeated toggles never accumulate rows', async () => {
    for (let i = 0; i < 5; i += 1) {
      await setProviderEnabled(companyY, providerIds.qwen, i % 2 === 0);
    }

    const rows = await db
      .select()
      .from(organizationProviders)
      .where(eq(organizationProviders.organizationId, companyY));

    const qwenRows = rows.filter((row) => row.providerId === providerIds.qwen);
    expect(qwenRows).toHaveLength(1);
    // Last write (i = 4) was enabled.
    expect(qwenRows[0].enabled).toBe(true);
  });

  it('set-all overwrites earlier individual choices', async () => {
    await setProviderEnabled(companyY, providerIds.anthropic, false);
    await setAllProvidersEnabled(companyY, true);

    expect(await isProviderEnabled(companyY, 'anthropic')).toBe(true);
  });

  it('advances updated_at through the database trigger', async () => {
    await setProviderEnabled(companyY, providerIds.deepgram, true);

    const [before] = await db
      .select({ updatedAt: organizationProviders.updatedAt })
      .from(organizationProviders)
      .where(eq(organizationProviders.providerId, providerIds.deepgram));

    await new Promise((resolve) => setTimeout(resolve, 10));
    await setProviderEnabled(companyY, providerIds.deepgram, false);

    const rows = await db
      .select({
        organizationId: organizationProviders.organizationId,
        updatedAt: organizationProviders.updatedAt,
      })
      .from(organizationProviders)
      .where(eq(organizationProviders.providerId, providerIds.deepgram));

    const after = rows.find((row) => row.organizationId === companyY)!;
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });
});

describe('provider id validation', () => {
  it('keeps only ids that exist in the catalogue', async () => {
    const known = await filterKnownProviderIds([
      providerIds.openai,
      '00000000-0000-0000-0000-000000000000',
    ]);

    // A crafted id from the client must never be stored.
    expect(known).toEqual([providerIds.openai]);
  });

  it('returns nothing for an empty list without querying', async () => {
    expect(await filterKnownProviderIds([])).toEqual([]);
  });
});
