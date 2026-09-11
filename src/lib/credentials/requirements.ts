/**
 * Per-provider registration requirements. Client-safe, so the form and the
 * server agree on which extra fields a provider needs.
 */

/** Providers whose API host is per resource and must be supplied with the key. */
export const ENDPOINT_PROVIDER_TYPES = ['azure_openai'] as const;

export function needsEndpoint(type: string): boolean {
  return (ENDPOINT_PROVIDER_TYPES as readonly string[]).includes(type);
}
