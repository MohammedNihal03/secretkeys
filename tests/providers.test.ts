import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseDurationMs, scrubSecrets } from '@/lib/providers/http';
import { anthropicAdapter } from '@/lib/providers/anthropic';
import { deepgramAdapter } from '@/lib/providers/deepgram';
import { elevenlabsAdapter } from '@/lib/providers/elevenlabs';
import { geminiAdapter } from '@/lib/providers/gemini';
import { groqAdapter } from '@/lib/providers/groq';
import { openaiAdapter } from '@/lib/providers/openai';
import { qwenAdapter } from '@/lib/providers/qwen';
import { PROVIDER_ADAPTERS, catalogueEntries, listAdapters } from '@/lib/providers/registry';
import type { AIProviderAdapter, Metric } from '@/lib/providers/types';

/**
 * Provider adapter tests.
 *
 * `fetch` is stubbed throughout -- these must never touch a real provider.
 * Payload fixtures mirror the documented response shapes, which is the only
 * practical way to pin down seven different APIs.
 */

const CREDENTIAL = { apiKey: 'test-key-not-real' };
const WINDOW = { start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-09-03T00:00:00Z') };

const ALL_ADAPTERS: [string, AIProviderAdapter][] = [
  ['openai', openaiAdapter],
  ['anthropic', anthropicAdapter],
  ['gemini', geminiAdapter],
  ['groq', groqAdapter],
  ['qwen', qwenAdapter],
  ['elevenlabs', elevenlabsAdapter],
  ['deepgram', deepgramAdapter],
];

/** Builds a stub Response. */
function jsonResponse(body: unknown, init: { status?: number; headers?: HeadersInit } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Asserts a metric is unavailable for a specific reason. */
function expectUnavailable<T>(metric: Metric<T>, reason: string) {
  expect(metric.available).toBe(false);
  if (!metric.available) expect(metric.reason).toBe(reason);
}

describe('registry', () => {
  it('has an adapter for every provider type in the database enum', () => {
    // The record is typed as total, so this guards the runtime mapping too.
    for (const [type, adapter] of Object.entries(PROVIDER_ADAPTERS)) {
      expect(adapter, `missing adapter for ${type}`).toBeDefined();
      expect(adapter.type).toBe(type);
    }
  });

  it('exposes all seven adapters', () => {
    expect(listAdapters()).toHaveLength(7);
  });

  it('derives catalogue entries with unique types', () => {
    const entries = catalogueEntries();
    const types = entries.map((entry) => entry.type);

    expect(new Set(types).size).toBe(types.length);
    expect(entries.every((entry) => entry.name.length > 0)).toBe(true);
  });

  it('orders LLMs before speech providers', () => {
    const categories = listAdapters().map((adapter) => adapter.category);
    const firstSpeech = categories.indexOf('speech');

    // Every LLM must come before the first speech provider.
    if (firstSpeech !== -1) {
      expect(categories.slice(firstSpeech).every((c) => c === 'speech')).toBe(true);
    }
  });
});

describe('credential validation', () => {
  it.each(ALL_ADAPTERS)('%s reports a valid credential', async (_name, adapter) => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [], projects: [], subscription: {} }));

    const result = await adapter.validateCredentials(CREDENTIAL);

    expect(result.valid).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it.each(ALL_ADAPTERS)('%s classifies a 401 as unauthorized', async (_name, adapter) => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { message: 'Invalid API key' } }, { status: 401 })
    );

    const result = await adapter.validateCredentials(CREDENTIAL);

    expect(result.valid).toBe(false);
    expect(result.failure).toBe('unauthorized');
    expect(result.detail).toContain('Invalid API key');
  });

  it.each(ALL_ADAPTERS)('%s classifies a 429 as rate limited', async (_name, adapter) => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'slow down' }, { status: 429 }));

    expect((await adapter.validateCredentials(CREDENTIAL)).failure).toBe('rate_limited');
  });

  it.each(ALL_ADAPTERS)('%s reports a network failure without throwing', async (_name, adapter) => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    const result = await adapter.validateCredentials(CREDENTIAL);

    expect(result.valid).toBe(false);
    expect(result.failure).toBe('network_error');
  });

  it.each(ALL_ADAPTERS)('%s never echoes the credential back', async (_name, adapter) => {
    const secret = 'sk-super-secret-value-123456';
    // A provider that unhelpfully includes the key in its error message.
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { message: `Invalid key ${secret}` } }, { status: 401 })
    );

    const result = await adapter.validateCredentials({ apiKey: secret });

    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('sends the API key in a header, never in the URL', async () => {
    // Gemini also accepts ?key=, which would leak the key into access logs.
    fetchMock.mockResolvedValue(jsonResponse({ models: [] }));

    await geminiAdapter.validateCredentials({ apiKey: 'AIzaSecretValue123456' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).not.toContain('AIzaSecretValue123456');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(
      'AIzaSecretValue123456'
    );
  });
});

describe('health', () => {
  it('reports healthy on a fast successful probe', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));

    const health = await openaiAdapter.fetchHealth(CREDENTIAL);

    expect(health.status).toBe('healthy');
    expect(health.reachable).toBe(true);
    expect(health.rateLimited).toBe(false);
  });

  it('treats a rate-limited provider as degraded, not down', async () => {
    // 429 means the provider is answering and the credential works.
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { message: 'rate limit' } }, { status: 429 })
    );

    const health = await groqAdapter.fetchHealth(CREDENTIAL);

    expect(health.status).toBe('degraded');
    expect(health.reachable).toBe(true);
    expect(health.rateLimited).toBe(true);
  });

  it('reports unhealthy when the provider is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const health = await anthropicAdapter.fetchHealth(CREDENTIAL);

    expect(health.status).toBe('unhealthy');
    expect(health.reachable).toBe(false);
  });
});

describe('providers with no usage API', () => {
  // Gemini, Groq and Qwen expose nothing. Reporting zero would read as
  // "healthy and idle" when the truth is "we cannot see it".
  it.each([
    ['gemini', geminiAdapter],
    ['groq', groqAdapter],
    ['qwen', qwenAdapter],
    ['elevenlabs', elevenlabsAdapter],
  ] as [string, AIProviderAdapter][])(
    '%s reports usage as explicitly unsupported, not zero',
    async (_name, adapter) => {
      const result = await adapter.fetchUsage({ credential: CREDENTIAL, window: WINDOW });

      expect(result.supported).toBe(false);
      if (!result.supported) {
        expect(result.reason).toBe('unsupported');
        expect(result.detail.length).toBeGreaterThan(20);
      }
    }
  );

  it('declares the limitation in its capabilities', () => {
    expect(geminiAdapter.capabilities.usage).toBe('none');
    expect(geminiAdapter.capabilities.cost).toBe('none');
    expect(geminiAdapter.capabilities.limits).toBe('none');
    expect(geminiAdapter.capabilities.notes).toMatch(/no usage/i);
  });
});

describe('admin-credential requirement', () => {
  it.each([
    ['openai', openaiAdapter, 'sk-proj-ordinary-key'],
    ['anthropic', anthropicAdapter, 'sk-ant-api03-ordinary-key'],
  ] as [string, AIProviderAdapter, string][])(
    '%s refuses usage for a non-admin key without calling the API',
    async (_name, adapter, ordinaryKey) => {
      const result = await adapter.fetchUsage({
        credential: { apiKey: ordinaryKey },
        window: WINDOW,
      });

      expect(result.supported).toBe(false);
      if (!result.supported) expect(result.reason).toBe('requires_admin_credential');
      // Refused locally: an ordinary key is not invalid, it is just insufficient.
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('declares usage as organization_admin for both', () => {
    expect(openaiAdapter.capabilities.usage).toBe('organization_admin');
    expect(anthropicAdapter.capabilities.usage).toBe('organization_admin');
  });
});

describe('OpenAI usage normalization', () => {
  /** Mirrors the documented `/v1/organization/usage/completions` shape. */
  const USAGE_PAYLOAD = {
    data: [
      {
        start_time: 1_756_684_800, // 2026-09-01T00:00:00Z
        end_time: 1_756_771_200,
        results: [
          {
            input_tokens: 1000,
            output_tokens: 250,
            input_cached_tokens: 400,
            num_model_requests: 12,
            api_key_id: 'key_abc',
            project_id: 'proj_1',
            model: 'gpt-5',
          },
        ],
      },
    ],
  };

  it('sums input and output into total tokens', () => {
    const [entry] = openaiAdapter.normalizeMetrics(USAGE_PAYLOAD, WINDOW);

    expect(entry.inputTokens).toEqual({ available: true, value: 1000 });
    expect(entry.outputTokens).toEqual({ available: true, value: 250 });
    expect(entry.totalTokens).toEqual({ available: true, value: 1250 });
    expect(entry.requests).toEqual({ available: true, value: 12 });
  });

  it('attributes the row to the provider key id', () => {
    const [entry] = openaiAdapter.normalizeMetrics(USAGE_PAYLOAD, WINDOW);

    // Without this the usage cannot be mapped to one of our projects.
    expect(entry.providerKeyId).toBe('key_abc');
  });

  it('does not invent a success/failure split', () => {
    const [entry] = openaiAdapter.normalizeMetrics(USAGE_PAYLOAD, WINDOW);

    // Reporting all requests as successful would hide an error spike.
    expectUnavailable(entry.successfulRequests, 'unsupported');
    expectUnavailable(entry.failedRequests, 'unsupported');
  });

  it('preserves provider-specific fields', () => {
    const [entry] = openaiAdapter.normalizeMetrics(USAGE_PAYLOAD, WINDOW);

    expect(entry.providerRaw).toMatchObject({ model: 'gpt-5', inputCachedTokens: 400 });
  });

  it('returns nothing for a malformed payload rather than throwing', () => {
    for (const payload of [null, undefined, {}, { data: 'nope' }, []]) {
      expect(openaiAdapter.normalizeMetrics(payload, WINDOW)).toEqual([]);
    }
  });

  it('treats missing token counts as zero, not NaN', () => {
    const [entry] = openaiAdapter.normalizeMetrics(
      { data: [{ start_time: 1_756_684_800, results: [{ api_key_id: 'key_x' }] }] },
      WINDOW
    );

    expect(entry.totalTokens).toEqual({ available: true, value: 0 });
  });
});

describe('Anthropic usage normalization', () => {
  /** Mirrors `/v1/organizations/usage_report/messages`. */
  const PAYLOAD = {
    data: [
      {
        starting_at: '2026-09-01T00:00:00Z',
        ending_at: '2026-09-02T00:00:00Z',
        results: [
          {
            uncached_input_tokens: 500,
            cache_read_input_tokens: 300,
            cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 50 },
            output_tokens: 200,
            api_key_id: 'apikey_1',
            model: 'claude-opus-5',
            service_tier: 'standard',
          },
        ],
      },
    ],
  };

  it('sums all three input token categories', () => {
    const [entry] = anthropicAdapter.normalizeMetrics(PAYLOAD, WINDOW);

    // 500 uncached + 300 cache read + 150 cache write. All are billed input.
    expect(entry.inputTokens).toEqual({ available: true, value: 950 });
    expect(entry.outputTokens).toEqual({ available: true, value: 200 });
    expect(entry.totalTokens).toEqual({ available: true, value: 1150 });
  });

  it('preserves the cache breakdown that normalization flattens', () => {
    const [entry] = anthropicAdapter.normalizeMetrics(PAYLOAD, WINDOW);

    expect(entry.providerRaw).toMatchObject({
      uncachedInputTokens: 500,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 150,
    });
  });

  it('accepts the older flat cache_creation_input_tokens shape', () => {
    const [entry] = anthropicAdapter.normalizeMetrics(
      {
        data: [
          {
            starting_at: '2026-09-01T00:00:00Z',
            results: [
              { uncached_input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 1 },
            ],
          },
        ],
      },
      WINDOW
    );

    expect(entry.inputTokens).toEqual({ available: true, value: 15 });
  });

  it('reports request count as unavailable', () => {
    const [entry] = anthropicAdapter.normalizeMetrics(PAYLOAD, WINDOW);

    // The usage report is token-based and carries no request count at all.
    expectUnavailable(entry.requests, 'unsupported');
  });

  it('tolerates an invalid date without producing an Invalid Date', () => {
    const [entry] = anthropicAdapter.normalizeMetrics(
      { data: [{ starting_at: 'not-a-date', results: [{ output_tokens: 1 }] }] },
      WINDOW
    );

    expect(Number.isNaN(entry.windowStart.getTime())).toBe(false);
    expect(entry.windowStart).toEqual(WINDOW.start);
  });
});

describe('Deepgram usage normalization', () => {
  /** Mirrors `/v1/projects/{id}/usage/breakdown`. */
  const PAYLOAD = {
    start: '2026-09-01',
    end: '2026-09-03',
    resolution: { units: 'day', amount: 1 },
    results: [
      {
        hours: 1.0,
        total_hours: 2.5,
        agent_hours: 0.5,
        tokens_in: 120,
        tokens_out: 80,
        tts_characters: 4000,
        requests: 42,
        grouping: { accessor: 'accessor_key_1', endpoint: 'listen', models: ['nova-3'] },
      },
    ],
  };

  it('converts billable hours to seconds', () => {
    const [entry] = deepgramAdapter.normalizeMetrics(PAYLOAD, WINDOW);

    // total_hours (2.5) is the billable figure, not hours (1.0).
    expect(entry.audioSeconds).toEqual({ available: true, value: 9000 });
  });

  it('records requests, tokens and characters', () => {
    const [entry] = deepgramAdapter.normalizeMetrics(PAYLOAD, WINDOW);

    expect(entry.requests).toEqual({ available: true, value: 42 });
    expect(entry.totalTokens).toEqual({ available: true, value: 200 });
    expect(entry.characters).toEqual({ available: true, value: 4000 });
  });

  it('attributes usage to the accessor, which is the API key', () => {
    const [entry] = deepgramAdapter.normalizeMetrics(PAYLOAD, WINDOW);

    expect(entry.providerKeyId).toBe('accessor_key_1');
  });

  it('reports cost as unavailable rather than deriving it', () => {
    const [entry] = deepgramAdapter.normalizeMetrics(PAYLOAD, WINDOW);

    // Deepgram reports consumption only; a local price list would drift.
    expectUnavailable(entry.estimatedCostUsd, 'unsupported');
  });

  it('marks absent audio and characters unavailable instead of zero', () => {
    const [entry] = deepgramAdapter.normalizeMetrics(
      { results: [{ requests: 1, grouping: {} }] },
      WINDOW
    );

    expectUnavailable(entry.audioSeconds, 'unsupported');
    expectUnavailable(entry.characters, 'unsupported');
  });

  it('fetches usage with grouping by accessor', async () => {
    fetchMock.mockResolvedValue(jsonResponse(PAYLOAD));

    const result = await deepgramAdapter.fetchUsage({
      credential: { apiKey: 'dg-key', providerProjectId: 'proj_dg' },
      window: WINDOW,
    });

    expect(result.supported).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/projects/proj_dg/usage/breakdown');
    expect(url).toContain('grouping=accessor');
    // Deepgram accepts YYYY-MM-DD only.
    expect(url).toContain('start=2026-09-01');
    expect((init.headers as Record<string, string>).Authorization).toBe('Token dg-key');
  });

  it('discovers the project id during validation', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ projects: [{ project_id: 'proj_found' }] }));

    const result = await deepgramAdapter.validateCredentials({ apiKey: 'dg-key' });

    expect(result.discovered?.providerProjectId).toBe('proj_found');
  });
});

describe('ElevenLabs quota', () => {
  const USER_PAYLOAD = {
    user_id: 'user_1',
    subscription: {
      character_count: 12_500,
      character_limit: 100_000,
      next_character_count_reset_unix: 1_759_276_800,
      tier: 'creator',
    },
  };

  it('reads the character quota as a real limit', async () => {
    fetchMock.mockResolvedValue(jsonResponse(USER_PAYLOAD));

    const limits = await elevenlabsAdapter.fetchLimits(CREDENTIAL);

    expect(limits.quotaUsed).toEqual({ available: true, value: 12_500 });
    expect(limits.quotaLimit).toEqual({ available: true, value: 100_000 });
    expect(limits.quotaUnit).toEqual({ available: true, value: 'characters' });
    expect(limits.resetsAt.available).toBe(true);
  });

  it('reports token and request limits as inapplicable', async () => {
    fetchMock.mockResolvedValue(jsonResponse(USER_PAYLOAD));

    const limits = await elevenlabsAdapter.fetchLimits(CREDENTIAL);

    // ElevenLabs meters characters; tokens are not a concept here.
    expectUnavailable(limits.tokensLimit, 'unsupported');
    expectUnavailable(limits.requestsLimit, 'unsupported');
  });

  it('uses the xi-api-key header', async () => {
    fetchMock.mockResolvedValue(jsonResponse(USER_PAYLOAD));

    await elevenlabsAdapter.fetchLimits({ apiKey: 'xi-secret' });

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('xi-secret');
  });

  it('reports a provider error when the subscription object is missing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user_id: 'u' }));

    const limits = await elevenlabsAdapter.fetchLimits(CREDENTIAL);

    expectUnavailable(limits.quotaUsed, 'provider_error');
  });
});

describe('rate-limit headers', () => {
  it('reads the OpenAI-style header family', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { data: [] },
        {
          headers: {
            'x-ratelimit-limit-requests': '14400',
            'x-ratelimit-remaining-requests': '14370',
            'x-ratelimit-limit-tokens': '6000',
            'x-ratelimit-remaining-tokens': '5850',
            'x-ratelimit-reset-tokens': '1.5s',
          },
        }
      )
    );

    const limits = await groqAdapter.fetchLimits(CREDENTIAL);

    expect(limits.requestsLimit).toEqual({ available: true, value: 14_400 });
    expect(limits.tokensRemaining).toEqual({ available: true, value: 5850 });
    expect(limits.resetsAt.available).toBe(true);
  });

  it('marks absent headers unavailable rather than zero', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));

    const limits = await groqAdapter.fetchLimits(CREDENTIAL);

    // Zero remaining would look like an exhausted quota.
    expectUnavailable(limits.requestsRemaining, 'unsupported');
  });

  it("reads Anthropic's own header prefix", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { data: [] },
        {
          headers: {
            'anthropic-ratelimit-requests-limit': '1000',
            'anthropic-ratelimit-tokens-remaining': '40000',
          },
        }
      )
    );

    const limits = await anthropicAdapter.fetchLimits(CREDENTIAL);

    expect(limits.requestsLimit).toEqual({ available: true, value: 1000 });
    expect(limits.tokensRemaining).toEqual({ available: true, value: 40_000 });
  });

  it('records rate-limited state when the limits probe itself is throttled', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'too many' }, { status: 429 }));

    expect((await groqAdapter.fetchLimits(CREDENTIAL)).rateLimited).toBe(true);
  });
});

describe('parseDurationMs', () => {
  it.each([
    ['1.5s', 1500],
    ['6m0s', 360_000],
    ['120ms', 120],
    ['1m30s', 90_000],
    ['2h', 7_200_000],
    // A bare number is seconds, per the Retry-After convention.
    ['30', 30_000],
  ])('parses %s', (input, expected) => {
    expect(parseDurationMs(input)).toBe(expected);
  });

  it.each([null, '', 'soon', 'abc'])('returns undefined for %j', (input) => {
    expect(parseDurationMs(input)).toBeUndefined();
  });
});

describe('scrubSecrets', () => {
  it.each([
    ['sk-abcdefghijklmnop', 'sk-***'],
    ['gsk_abcdefghijklmnop', 'gsk_***'],
    ['AIzaAbCdEfGhIjKlMnOp', 'AIza***'],
  ])('redacts %s', (secret, expected) => {
    expect(scrubSecrets(`Invalid key: ${secret}`)).toBe(`Invalid key: ${expected}`);
  });

  it('redacts bearer and token schemes', () => {
    expect(scrubSecrets('Authorization: Bearer abcdefghijkl')).toContain('Bearer ***');
    expect(scrubSecrets('Authorization: Token abcdefghijkl')).toContain('Token ***');
  });

  it('leaves ordinary text alone', () => {
    expect(scrubSecrets('rate limit exceeded for model gpt-5')).toBe(
      'rate limit exceeded for model gpt-5'
    );
  });
});

describe('timeouts', () => {
  it('reports a timeout distinctly from a network error', async () => {
    // Never settles, so the adapter's own timeout must fire.
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        })
    );

    vi.useFakeTimers();
    const pending = openaiAdapter.validateCredentials(CREDENTIAL);
    await vi.advanceTimersByTimeAsync(16_000);
    const result = await pending;
    vi.useRealTimers();

    expect(result.valid).toBe(false);
    expect(result.failure).toBe('timeout');
  });
});
