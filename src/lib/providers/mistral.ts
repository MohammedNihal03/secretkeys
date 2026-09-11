import { createOpenAICompatibleAdapter } from './openai-compatible';

/**
 * Mistral adapter.
 *
 * Docs: https://docs.mistral.ai/api
 *
 * `GET /v1/models` with a Bearer key validates the credential. Mistral exposes
 * no usage, cost or quota endpoint.
 *
 * Mistral does enforce per-key rate limits, but no authoritative documentation
 * of its rate-limit response headers could be verified, so none are read --
 * reporting numbers from guessed header names would be worse than reporting
 * nothing. Declaring `limits: 'none'` is what stops the shared factory reading
 * them. A rejected call (429) is still recorded as rate-limited.
 */
export const mistralAdapter = createOpenAICompatibleAdapter({
  type: 'mistral',
  displayName: 'Mistral',
  baseUrl: 'https://api.mistral.ai/v1',
  capabilities: {
    usage: 'none',
    cost: 'none',
    limits: 'none',
    meters: ['requests', 'tokens'],
    notes:
      'No usage, cost or quota endpoint. Rate limits are enforced per key but their response headers are not documented in a way that could be verified, so only rejected (429) calls are recorded.',
  },
  noUsageDetail:
    'Mistral exposes no usage or cost endpoint. Usage and spend are visible in the Mistral console.',
});
