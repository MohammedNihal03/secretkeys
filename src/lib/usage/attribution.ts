import type { CollectionTarget } from '@/lib/collector/types';
import type { NormalizedUsage } from '@/lib/providers/types';

/**
 * Deciding which credential a usage row belongs to.
 *
 * Providers that expose usage at the organization level return every key's
 * consumption in one response, grouped by *their* key identifier. Attributing
 * that to the credential that happened to make the request would put another
 * team's spend on this project's bill -- the exact failure this system exists
 * to prevent -- so an unrecognised identifier is reported, never guessed.
 */

/** Where a usage row lands. */
export interface KeyAttribution {
  apiKeyId: string;
  projectId: string;
}

/**
 * The organization's registered keys for one provider, indexed by the
 * provider's own identifier for them.
 *
 * The collecting credential is in here too when its own provider key id is
 * known, so no special case is needed for "this row is ours".
 */
export type KeyDirectory = ReadonlyMap<string, KeyAttribution>;

export interface AttributedEntry {
  entry: NormalizedUsage;
  attribution: KeyAttribution;
}

export interface AttributionResult {
  attributed: AttributedEntry[];
  /** Entries deliberately dropped, with one message per unknown identifier. */
  skipped: number;
  notes: string[];
}

export function attributeEntries(
  target: CollectionTarget,
  entries: readonly NormalizedUsage[],
  directory: KeyDirectory
): AttributionResult {
  const self: KeyAttribution = { apiKeyId: target.apiKeyId, projectId: target.projectId };

  const attributed: AttributedEntry[] = [];
  const unknown = new Map<string, number>();

  for (const entry of entries) {
    const providerKeyId = entry.providerKeyId;

    if (!providerKeyId) {
      /**
       * A response that names no key answered the credential we asked with, so
       * it describes that credential.
       */
      attributed.push({ entry, attribution: self });
      continue;
    }

    const known = directory.get(providerKeyId);

    if (known) {
      attributed.push({ entry, attribution: known });
      continue;
    }

    unknown.set(providerKeyId, (unknown.get(providerKeyId) ?? 0) + 1);
  }

  const notes = [...unknown.entries()].map(
    ([providerKeyId, count]) =>
      `${target.providerName} reported usage for key "${providerKeyId}", which is not registered here — ` +
      `${count} ${count === 1 ? 'interval was' : 'intervals were'} not stored. ` +
      `Register that key, or set its provider key id, to attribute it to a project.`
  );

  return {
    attributed,
    skipped: [...unknown.values()].reduce((total, count) => total + count, 0),
    notes,
  };
}
