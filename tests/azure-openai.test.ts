import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AZURE_API_VERSION,
  azureOpenaiAdapter,
  parseAzureEndpoint,
} from '@/lib/providers/azure-openai';

/**
 * Azure OpenAI adapter, and the endpoint allow-list that stops the key form
 * becoming a server-side request forgery vector.
 */

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseAzureEndpoint', () => {
  it.each([
    ['https://my-resource.openai.azure.com', 'https://my-resource.openai.azure.com'],
    ['https://my-resource.openai.azure.com/', 'https://my-resource.openai.azure.com'],
    ['  https://My-Resource.OpenAI.Azure.com  ', 'https://my-resource.openai.azure.com'],
    [
      'https://ai-svc-01.cognitiveservices.azure.com',
      'https://ai-svc-01.cognitiveservices.azure.com',
    ],
    // A pasted deployment URL is reduced to its origin.
    [
      'https://my-resource.openai.azure.com/openai/deployments/gpt/chat?api-version=x#frag',
      'https://my-resource.openai.azure.com',
    ],
    ['https://my-resource.openai.azure.com:443', 'https://my-resource.openai.azure.com'],
  ])('accepts %s', (input, expected) => {
    expect(parseAzureEndpoint(input)).toEqual({ ok: true, baseUrl: expected });
  });

  // Each of these would let the server make an authenticated request somewhere
  // other than an Azure OpenAI resource.
  it.each([
    ['plain http', 'http://my-resource.openai.azure.com'],
    ['another host', 'https://example.com'],
    ['look-alike suffix', 'https://openai.azure.com.example.com'],
    ['resource name smuggled in', 'https://my-resource.openai.azure.com.example.com'],
    ['bare suffix', 'https://openai.azure.com'],
    ['nested subdomain', 'https://a.b.openai.azure.com'],
    ['localhost', 'https://localhost'],
    ['cloud metadata address', 'https://169.254.169.254/latest/meta-data'],
    ['private address', 'https://10.0.0.5'],
    ['embedded credentials', 'https://user:pass@my-resource.openai.azure.com'],
    ['non-standard port', 'https://my-resource.openai.azure.com:8443'],
    ['invalid label', 'https://-bad-.openai.azure.com'],
    ['not a URL', 'my-resource'],
    ['empty', ''],
  ])('rejects %s', (_label, input) => {
    expect(parseAzureEndpoint(input).ok).toBe(false);
  });
});

describe('validation', () => {
  it('refuses without an endpoint and makes no request', async () => {
    const result = await azureOpenaiAdapter.validateCredentials({ apiKey: 'azure-key-123456789' });

    expect(result.valid).toBe(false);
    expect(result.failure).toBe('misconfigured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a disallowed endpoint without calling it', async () => {
    const result = await azureOpenaiAdapter.validateCredentials({
      apiKey: 'azure-key-123456789',
      baseUrl: 'https://169.254.169.254',
    });

    expect(result.failure).toBe('misconfigured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('probes the models endpoint with the api-key header', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const result = await azureOpenaiAdapter.validateCredentials({
      apiKey: 'azure-key-123456789',
      baseUrl: 'https://my-resource.openai.azure.com/some/path',
    });

    expect(result.valid).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `https://my-resource.openai.azure.com/openai/models?api-version=${AZURE_API_VERSION}`
    );

    const headers = init.headers as Record<string, string>;
    expect(headers['api-key']).toBe('azure-key-123456789');
    // Azure keys go in `api-key`, not a bearer token.
    expect(headers.Authorization).toBeUndefined();
  });

  it('classifies a rejected key as unauthorized', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Access denied' } }), { status: 401 })
    );

    const result = await azureOpenaiAdapter.validateCredentials({
      apiKey: 'azure-key-123456789',
      baseUrl: 'https://my-resource.openai.azure.com',
    });

    expect(result.failure).toBe('unauthorized');
  });
});

describe('health and capabilities', () => {
  it('reports unknown, not unhealthy, when no endpoint is configured', async () => {
    const health = await azureOpenaiAdapter.fetchHealth({ apiKey: 'azure-key-123456789' });

    // Nothing was checked, so claiming the service is down would be false.
    expect(health.status).toBe('unknown');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('declares usage, cost and limits as not exposed', () => {
    expect(azureOpenaiAdapter.capabilities).toMatchObject({
      usage: 'none',
      cost: 'none',
      limits: 'none',
    });
  });

  it('reports usage as unsupported', async () => {
    const result = await azureOpenaiAdapter.fetchUsage({
      credential: { apiKey: 'k', baseUrl: 'https://my-resource.openai.azure.com' },
      window: { start: new Date(0), end: new Date() },
    });

    expect(result.supported).toBe(false);
  });
});
