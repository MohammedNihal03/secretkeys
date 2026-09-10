import { createOpenAICompatibleAdapter } from './openai-compatible';

/**
 * Groq adapter.
 *
 * Docs: https://console.groq.com/docs
 *
 * Groq serves an OpenAI-compatible API at `/openai/v1`, so validation, health
 * and rate-limit reading are shared with the other compatible providers.
 *
 * Groq exposes no usage or cost endpoint. It does return the full
 * `x-ratelimit-*` header family, which makes it one of the better providers for
 * limit monitoring -- but note the documented semantics differ from OpenAI's:
 * `x-ratelimit-limit-requests` is requests per **day** and
 * `x-ratelimit-limit-tokens` is tokens per **minute**.
 */
export const groqAdapter = createOpenAICompatibleAdapter({
  type: 'groq',
  displayName: 'Groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  capabilities: {
    usage: 'none',
    cost: 'none',
    limits: 'response_headers',
    meters: ['requests', 'tokens'],
    notes:
      'No usage or cost endpoint. Rate limits are returned as response headers, where the request limit is per day and the token limit is per minute. Per-request token counts are only available in inference responses.',
  },
  noUsageDetail:
    'Groq exposes no usage or cost endpoint. Token counts are returned inside each inference response, so consumption can only be recorded by instrumenting calls rather than by polling.',
});
