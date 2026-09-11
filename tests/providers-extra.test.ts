import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deepseekAdapter, readDeepSeekLimits } from '@/lib/providers/deepseek';
import { mistralAdapter } from '@/lib/providers/mistral';
import { openrouterAdapter, readOpenRouterLimits } from '@/lib/providers/openrouter';
import { qwenAdapter } from '@/lib/providers/qwen';
import { listAdapters } from '@/lib/providers/registry';
import type { Metric } from '@/lib/providers/types';

/**
 * OpenRouter, DeepSeek and Mistral, plus the Qwen header fix made alongside
 * them. `fetch` is stubbed; fixtures mirror the documented response shapes.
 */

const CREDENTIAL = { apiKey: 'test-key-not-real' };

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
});

function expectUnavailable<T>(metric: Metric<T>, reason: string, detailPattern?: RegExp) {
  expect(metric.available).toBe(false);
  if (!metric.available) {
    expect(metric.reason).toBe(reason);
    if (detailPattern) expect(metric.detail).toMatch(detailPattern);
  }
}

describe('registry', () => {
  it('includes the three new providers', () => {
    const types = listAdapters().map((adapter) => adapter.type);

    expect(types).toEqual(expect.arrayContaining(['openrouter', 'deepseek', 'mistral']));
  });
});

describe('OpenRouter', () => {
  /** Mirrors `GET /api/v1/key`. */
  const KEY_PAYLOAD = {
    data: {
      label: 'sk-or-v1-abc...xyz',
      limit: 100,
      limit_reset: 'monthly',
      limit_remaining: 72.5,
      include_byok_in_limit: false,
      usage: 480.25,
      usage_daily: 1.5,
      usage_weekly: 9.75,
      usage_monthly: 27.5,
      byok_usage: 0,
      byok_usage_daily: 0,
      byok_usage_weekly: 0,
      byok_usage_monthly: 0,
      is_free_tier: false,
    },
  };

  it('derives quota used from limit minus remaining, in USD', () => {
    const limits = readOpenRouterLimits(KEY_PAYLOAD);

    expect(limits.quotaLimit).toEqual({ available: true, value: 100 });
    expect(limits.quotaUsed).toEqual({ available: true, value: 27.5 });
    expect(limits.quotaUnit).toEqual({ available: true, value: 'usd' });
  });

  it('names the reset period without inventing a reset time', () => {
    const limits = readOpenRouterLimits(KEY_PAYLOAD);

    expectUnavailable(limits.resetsAt, 'unsupported', /monthly/);
  });

  it('preserves spend totals', () => {
    expect(readOpenRouterLimits(KEY_PAYLOAD).providerRaw).toMatchObject({
      usageDaily: 1.5,
      usageWeekly: 9.75,
      usageMonthly: 27.5,
      usageTotal: 480.25,
      isFreeTier: false,
    });
  });

  it('never carries the key label, which can contain a masked key', () => {
    expect(JSON.stringify(readOpenRouterLimits(KEY_PAYLOAD))).not.toContain('sk-or-v1');
  });

  it('reports an unlimited key as having no quota rather than a zero limit', () => {
    const limits = readOpenRouterLimits({
      data: { ...KEY_PAYLOAD.data, limit: null, limit_remaining: null, limit_reset: null },
    });

    // A zero limit would read as an exhausted key.
    expectUnavailable(limits.quotaLimit, 'unsupported', /No credit limit/);
    expectUnavailable(limits.quotaUsed, 'unsupported', /No credit limit/);
    expectUnavailable(limits.resetsAt, 'unsupported', /does not reset/);
  });

  it('never reports negative usage if remaining exceeds the limit', () => {
    const limits = readOpenRouterLimits({
      data: { ...KEY_PAYLOAD.data, limit: 10, limit_remaining: 12 },
    });

    expect(limits.quotaUsed).toEqual({ available: true, value: 0 });
  });

  it('reports a provider error for a malformed response', () => {
    for (const payload of [null, {}, { data: 'nope' }]) {
      expectUnavailable(readOpenRouterLimits(payload).quotaLimit, 'provider_error');
    }
  });

  it('validates against the key endpoint and returns limits in the same call', async () => {
    fetchMock.mockResolvedValue(jsonResponse(KEY_PAYLOAD));

    const result = await openrouterAdapter.validateCredentials({ apiKey: 'sk-or-secret' });

    expect(result.valid).toBe(true);
    expect(result.limits?.quotaLimit).toEqual({ available: true, value: 100 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/key');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-secret');
  });

  it('declares cost as per key and limits as an endpoint', () => {
    expect(openrouterAdapter.capabilities.cost).toBe('per_key');
    expect(openrouterAdapter.capabilities.limits).toBe('endpoint');
    expect(openrouterAdapter.capabilities.usage).toBe('none');
  });

  it('reports windowed usage as unsupported', async () => {
    const result = await openrouterAdapter.fetchUsage({
      credential: CREDENTIAL,
      window: { start: new Date(0), end: new Date() },
    });

    expect(result.supported).toBe(false);
  });
});

describe('DeepSeek', () => {
  /** Mirrors `GET /user/balance`. */
  const BALANCE_PAYLOAD = {
    is_available: true,
    balance_infos: [
      {
        currency: 'CNY',
        total_balance: '110.00',
        granted_balance: '10.00',
        topped_up_balance: '100.00',
      },
      {
        currency: 'USD',
        total_balance: '5.50',
        granted_balance: '0.00',
        topped_up_balance: '5.50',
      },
    ],
  };

  it('parses decimal-string balances per currency without converting', () => {
    const limits = readDeepSeekLimits(BALANCE_PAYLOAD);

    expect(limits.balance).toEqual({
      available: true,
      value: [
        { amount: 110, currency: 'CNY' },
        { amount: 5.5, currency: 'USD' },
      ],
    });
  });

  it('drops an unparseable entry rather than reporting it as zero', () => {
    const limits = readDeepSeekLimits({
      is_available: true,
      balance_infos: [
        { currency: 'USD', total_balance: 'not-a-number' },
        { total_balance: '3.00' },
        { currency: 'CNY', total_balance: '7.25' },
      ],
    });

    expect(limits.balance).toEqual({ available: true, value: [{ amount: 7.25, currency: 'CNY' }] });
  });

  it('reports no balance when none is returned', () => {
    expectUnavailable(
      readDeepSeekLimits({ is_available: true, balance_infos: [] }).balance,
      'unsupported'
    );
  });

  it('does not pretend a prepaid balance is a quota', () => {
    const limits = readDeepSeekLimits(BALANCE_PAYLOAD);

    expectUnavailable(limits.quotaLimit, 'unsupported', /prepaid/);
    expectUnavailable(limits.quotaUsed, 'unsupported', /prepaid/);
  });

  function routeFetch(balanceBody: unknown, balanceStatus = 200) {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/user/balance')
        ? jsonResponse(balanceBody, { status: balanceStatus })
        : jsonResponse({ object: 'list', data: [] })
    );
  }

  it('reports unhealthy when the balance can no longer cover API calls', async () => {
    routeFetch({ is_available: false, balance_infos: [] });

    const health = await deepseekAdapter.fetchHealth(CREDENTIAL);

    // Reachable, but every call will fail -- that must not read as healthy.
    expect(health.status).toBe('unhealthy');
    expect(health.reachable).toBe(true);
    expect(health.error).toMatch(/Insufficient balance/);
  });

  it('reports healthy when the balance is sufficient', async () => {
    routeFetch(BALANCE_PAYLOAD);

    expect((await deepseekAdapter.fetchHealth(CREDENTIAL)).status).toBe('healthy');
  });

  it('keeps the reachability result when the balance check itself fails', async () => {
    routeFetch({ error: { message: 'internal' } }, 500);

    expect((await deepseekAdapter.fetchHealth(CREDENTIAL)).status).toBe('healthy');
  });

  it('skips the balance check when the service is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const health = await deepseekAdapter.fetchHealth(CREDENTIAL);

    expect(health.status).toBe('unhealthy');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('validates against the models endpoint', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ object: 'list', data: [] }));

    await deepseekAdapter.validateCredentials(CREDENTIAL);

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/models');
  });
});

describe('providers that must not read rate-limit headers', () => {
  const HEADERS = {
    'x-ratelimit-limit-requests': '100',
    'x-ratelimit-remaining-requests': '99',
    'x-ratelimit-limit-tokens': '5000',
  };

  it.each([
    ['mistral', mistralAdapter],
    ['qwen', qwenAdapter],
  ])('%s ignores headers it has not been verified to send', async (_name, adapter) => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }, { headers: HEADERS }));

    const limits = await adapter.fetchLimits(CREDENTIAL);

    // Reading numbers from unverified header names would be worse than nothing.
    expectUnavailable(limits.requestsLimit, 'unsupported');
    expectUnavailable(limits.tokensLimit, 'unsupported');
    expect(adapter.capabilities.limits).toBe('none');
  });

  it.each([
    ['mistral', mistralAdapter],
    ['qwen', qwenAdapter],
  ])('%s still records a rejected call as rate limited', async (_name, adapter) => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Rate limit exceeded' }, { status: 429 }));

    expect((await adapter.fetchLimits(CREDENTIAL)).rateLimited).toBe(true);
  });

  it('Mistral validates against its models endpoint with a bearer key', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));

    await mistralAdapter.validateCredentials({ apiKey: 'mistral-secret' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.mistral.ai/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer mistral-secret');
  });
});
