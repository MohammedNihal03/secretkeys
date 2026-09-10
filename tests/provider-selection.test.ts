import { describe, expect, it } from 'vitest';

import { resolveProviderSelection } from '@/lib/providers/selection';
import { catalogueEntries } from '@/lib/providers/registry';
import type { AiProviderType } from '@/lib/providers/types';

/**
 * Provider selection merge rules.
 *
 * The default-when-absent rule is the substance of the feature, so it is tested
 * directly rather than through the database.
 */

/** A catalogue mirroring what `db:seed` produces, with stable ids. */
const CATALOGUE = catalogueEntries().map((entry, index) => ({
  id: `provider-${index}`,
  type: entry.type,
}));

function idOf(type: AiProviderType): string {
  const found = CATALOGUE.find((row) => row.type === type);
  if (!found) throw new Error(`no catalogue row for ${type}`);
  return found.id;
}

describe('default when no choice is stored', () => {
  it('enables every provider', () => {
    const selection = resolveProviderSelection(CATALOGUE, []);

    // Absent means enabled: a newly shipped adapter must not be silently
    // withheld from an organization that never expressed an opinion.
    expect(selection).toHaveLength(CATALOGUE.length);
    expect(selection.every((entry) => entry.enabled)).toBe(true);
  });

  it('marks them as not explicitly chosen', () => {
    const selection = resolveProviderSelection(CATALOGUE, []);

    expect(selection.every((entry) => entry.explicit === false)).toBe(true);
  });
});

describe('company X: only OpenAI and ElevenLabs', () => {
  /** Everything off, then the two in use switched back on. */
  const choices = CATALOGUE.map((row) => ({
    providerId: row.id,
    enabled: row.type === 'openai' || row.type === 'elevenlabs',
  }));

  it('tracks exactly the two selected', () => {
    const enabled = resolveProviderSelection(CATALOGUE, choices)
      .filter((entry) => entry.enabled)
      .map((entry) => entry.type)
      .sort();

    expect(enabled).toEqual(['elevenlabs', 'openai']);
  });

  it('leaves the rest present but not tracked', () => {
    const selection = resolveProviderSelection(CATALOGUE, choices);
    const untracked = selection.filter((entry) => !entry.enabled);

    // Still listed, so they can be switched on later without hunting.
    expect(untracked).toHaveLength(CATALOGUE.length - 2);
    expect(untracked.every((entry) => entry.explicit)).toBe(true);
  });

  it('does not resurrect a disabled provider when a new adapter ships', () => {
    // A catalogue that has grown by one, with no choice stored for the newcomer.
    const grown = [...CATALOGUE, { id: 'provider-new', type: 'openai' as AiProviderType }];
    const selection = resolveProviderSelection(grown, choices);

    const disabled = selection.filter((entry) => !entry.enabled);
    expect(disabled.length).toBe(CATALOGUE.length - 2);
  });
});

describe('company Y: all providers', () => {
  it('tracks everything when all are explicitly enabled', () => {
    const choices = CATALOGUE.map((row) => ({ providerId: row.id, enabled: true }));
    const selection = resolveProviderSelection(CATALOGUE, choices);

    expect(selection.every((entry) => entry.enabled)).toBe(true);
    // Explicit, so "everything on deliberately" is distinguishable from
    // "nobody has decided yet".
    expect(selection.every((entry) => entry.explicit)).toBe(true);
  });
});

describe('stored choice precedence', () => {
  it('lets an explicit disable override the default', () => {
    const selection = resolveProviderSelection(CATALOGUE, [
      { providerId: idOf('google_gemini'), enabled: false },
    ]);

    const gemini = selection.find((entry) => entry.type === 'google_gemini');
    expect(gemini?.enabled).toBe(false);
    expect(gemini?.explicit).toBe(true);

    // Everything else still defaults on.
    expect(selection.filter((entry) => entry.enabled)).toHaveLength(CATALOGUE.length - 1);
  });

  it('ignores a stored choice for a provider not in the catalogue', () => {
    const selection = resolveProviderSelection(CATALOGUE, [
      { providerId: 'provider-that-was-removed', enabled: false },
    ]);

    // A stale row must not remove a provider that does exist.
    expect(selection).toHaveLength(CATALOGUE.length);
    expect(selection.every((entry) => entry.enabled)).toBe(true);
  });
});

describe('catalogue rows without an adapter', () => {
  it('are omitted entirely', () => {
    const withOrphan = [
      ...CATALOGUE,
      // A type the registry has no adapter for cannot be collected from.
      { id: 'provider-orphan', type: 'not_a_real_provider' as AiProviderType },
    ];

    const selection = resolveProviderSelection(withOrphan, []);

    // Offering it would be a toggle that does nothing.
    expect(selection).toHaveLength(CATALOGUE.length);
    expect(selection.map((entry) => entry.providerId)).not.toContain('provider-orphan');
  });
});

describe('ordering', () => {
  it('puts LLMs before speech providers', () => {
    const categories = resolveProviderSelection(CATALOGUE, []).map(
      (entry) => entry.adapter.category
    );
    const firstSpeech = categories.indexOf('speech');

    if (firstSpeech !== -1) {
      expect(categories.slice(firstSpeech).every((c) => c === 'speech')).toBe(true);
    }
  });

  it('is alphabetical within a category', () => {
    const llmNames = resolveProviderSelection(CATALOGUE, [])
      .filter((entry) => entry.adapter.category === 'llm')
      .map((entry) => entry.displayName);

    expect(llmNames).toEqual([...llmNames].sort((a, b) => a.localeCompare(b)));
  });

  it('does not change with the stored choices', () => {
    const withNone = resolveProviderSelection(CATALOGUE, []).map((e) => e.type);
    const withSome = resolveProviderSelection(CATALOGUE, [
      { providerId: idOf('openai'), enabled: false },
    ]).map((e) => e.type);

    // Otherwise a row would jump position as it is toggled.
    expect(withSome).toEqual(withNone);
  });
});
