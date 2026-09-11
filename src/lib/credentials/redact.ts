import { scrubSecrets } from '@/lib/providers/http';

/**
 * Removes a known secret from provider-supplied text.
 *
 * `scrubSecrets` only catches key *shapes* it recognises (`sk-…`, `AIza…`,
 * bearer tokens). Some providers issue keys with no recognisable prefix, and
 * some echo the offending key back in an error. Here the actual secret is
 * known, so it -- and the leading and trailing fragments a provider might
 * print in a truncated form -- are removed exactly, before anything is shown
 * to a user or written to the database.
 */
export function redactSecret(text: string | undefined, secret: string): string | undefined {
  if (!text) return text;

  const fragments = [secret, secret.slice(0, 12), secret.slice(-8)]
    // Short fragments would match ordinary words and mangle the message.
    .filter((fragment) => fragment.length >= 8)
    // Longest first, so a fragment never splits the full secret.
    .sort((a, b) => b.length - a.length);

  let redacted = text;
  for (const fragment of fragments) {
    redacted = redacted.split(fragment).join('***');
  }

  return scrubSecrets(redacted);
}
