/**
 * Display-safe identification of a credential.
 *
 * Client-safe: no `node:crypto`, no database. Only the trailing characters ever
 * leave the server, and only this module turns them into what a person sees.
 */

/**
 * Shortest secret accepted.
 *
 * Every supported provider issues far longer keys. The floor exists because
 * storing the last four characters of a short secret would reveal a large
 * fraction of it.
 */
export const MIN_SECRET_LENGTH = 16;

export const MAX_SECRET_LENGTH = 512;

/** How many trailing characters are stored for identification. */
export const VISIBLE_SUFFIX_LENGTH = 4;

/** The suffix to store. Never call this on anything except a validated secret. */
export function secretSuffix(secret: string): string {
  return secret.slice(-VISIBLE_SUFFIX_LENGTH);
}

/** How a stored credential is shown, e.g. `••••A91F`. */
export function maskedKey(suffix: string): string {
  return `••••${suffix}`;
}
