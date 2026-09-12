import { describe, expect, it, vi } from 'vitest';

import { collectTarget } from '@/lib/collector/collect-target';
import {
  classifyOutcome,
  collectUnavailable,
  deriveHealth,
  limitsErrored,
} from '@/lib/collector/interpret';
import { backoffDelay, isTransient, withRetry } from '@/lib/collector/retry';
import { runCollection } from '@/lib/collector/runner';
import { discardingUsageSink } from '@/lib/collector/sink';
import type { CollectionTarget, CollectorRunRecord, UsageSink } from '@/lib/collector/types';
import { PROVIDER_DEGRADED_LATENCY_MS } from '@/lib/providers/probe';
import {
  available,
  noLimits,
  unsupported,
  type AIProviderAdapter,
  type AiProviderType,
  type ProviderCredential,
  type CredentialFailure,
  type CredentialValidation,
  type NormalizedLimits,
  type NormalizedUsage,
  type ProviderCapabilities,
  type UsageResult,
  type UsageWindow,
} from '@/lib/providers/types';

/**
 * Collector orchestration. Everything is injected, so none of this touches a
 * network or a database -- the integration suite covers the real wiring.
 */

const WINDOW: UsageWindow = {
  start: new Date('2026-09-09T00:00:00Z'),
  end: new Date('2026-09-11T00:00:00Z'),
};

const CREDENTIAL = { apiKey: 'test-key-not-real' };

function target(overrides: Partial<CollectionTarget> = {}): CollectionTarget {
  return {
    organizationId: 'org-1',
    organizationName: 'Acme',
    projectId: 'project-1',
    projectName: 'FYIND',
    providerId: 'provider-1',
    providerType: 'openai',
    providerName: 'OpenAI',
    apiKeyId: 'key-1',
    keyName: 'FYIND Production',
    environment: 'production',
    ...overrides,
  };
}

function capabilities(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    usage: 'per_key',
    cost: 'per_key',
    limits: 'endpoint',
    meters: ['requests', 'tokens'],
    notes: 'test provider',
    ...overrides,
  };
}

function usageEntry(): NormalizedUsage {
  return {
    windowStart: WINDOW.start,
    windowEnd: WINDOW.end,
    requests: available(10),
    successfulRequests: unsupported('n/a'),
    failedRequests: unsupported('n/a'),
    inputTokens: available(100),
    outputTokens: available(20),
    totalTokens: available(120),
    characters: unsupported('n/a'),
    audioSeconds: unsupported('n/a'),
    estimatedCostUsd: available(0.5),
  };
}

interface FakeAdapterOptions {
  caps?: Partial<ProviderCapabilities>;
  validations?: CredentialValidation[];
  limits?: NormalizedLimits;
  usage?: UsageResult;
}

/** A stand-in adapter that records what the collector asked it for. */
function fakeAdapter(options: FakeAdapterOptions = {}) {
  const validations = options.validations ?? [{ valid: true, latencyMs: 12 }];
  let call = 0;

  const validateCredentials = vi.fn(async () => {
    const validation = validations[Math.min(call, validations.length - 1)];
    call += 1;
    return validation;
  });

  const fetchLimits = vi.fn(async () => options.limits ?? noLimits('unsupported', 'none'));
  const fetchUsage = vi.fn(
    async () => options.usage ?? ({ supported: true, entries: [usageEntry()] } as UsageResult)
  );

  const adapter: AIProviderAdapter = {
    type: 'openai',
    displayName: 'OpenAI',
    category: 'llm',
    capabilities: capabilities(options.caps),
    validateCredentials,
    fetchLimits,
    fetchUsage,
    fetchHealth: vi.fn(async () => ({
      status: 'healthy' as const,
      reachable: true,
      latencyMs: 1,
      rateLimited: false,
    })),
    normalizeMetrics: () => [],
  };

  return { adapter, validateCredentials, fetchLimits, fetchUsage };
}

const failed = (failure: CredentialFailure, detail = 'nope'): CredentialValidation => ({
  valid: false,
  failure,
  detail,
  latencyMs: 5,
});

describe('isTransient', () => {
  it.each(['network_error', 'timeout', 'rate_limited', 'unexpected_status'] as const)(
    'retries %s',
    (failure) => {
      expect(isTransient(failure)).toBe(true);
    }
  );

  // Retrying these turns one clear answer into several identical ones.
  it.each(['unauthorized', 'forbidden', 'misconfigured', undefined] as const)(
    'does not retry %s',
    (failure) => {
      expect(isTransient(failure)).toBe(false);
    }
  );
});

describe('withRetry', () => {
  const sleep = async () => {};

  it('returns immediately when the first result is final', async () => {
    const operation = vi.fn(async () => 'ok');

    const run = await withRetry(operation, () => false, { sleep });

    expect(run.attempts).toBe(1);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries until the result is final', async () => {
    let calls = 0;
    const operation = vi.fn(async () => {
      calls += 1;
      return calls < 3 ? 'retry' : 'ok';
    });

    const run = await withRetry(operation, (value) => value === 'retry', { sleep, attempts: 5 });

    expect(run.result).toBe('ok');
    expect(run.attempts).toBe(3);
  });

  it('gives up after the attempt budget and still returns the last result', async () => {
    const operation = vi.fn(async () => 'retry');

    const run = await withRetry(operation, () => true, { sleep, attempts: 3 });

    // The caller still has to report what happened, so no throw.
    expect(run.result).toBe('retry');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(run.delays).toHaveLength(2);
  });

  it('waits longer between later attempts', async () => {
    const waited: number[] = [];

    await withRetry(
      async () => 'retry',
      () => true,
      {
        attempts: 4,
        baseDelayMs: 100,
        random: () => 1,
        sleep: async (ms) => {
          waited.push(ms);
        },
      }
    );

    expect(waited).toEqual([100, 200, 400]);
  });

  it('jitters the delay so every credential does not retry in lockstep', () => {
    expect(backoffDelay(1, { baseDelayMs: 100, random: () => 0 })).toBe(0);
    expect(backoffDelay(1, { baseDelayMs: 100, random: () => 0.5 })).toBe(50);
    expect(backoffDelay(3, { baseDelayMs: 100, random: () => 1 })).toBe(400);
  });
});

describe('deriveHealth', () => {
  it('is healthy for a fast valid probe', () => {
    expect(deriveHealth({ valid: true, latencyMs: 10 })).toMatchObject({
      status: 'healthy',
      reachable: true,
      rateLimited: false,
    });
  });

  it('is degraded when the probe is slow', () => {
    expect(deriveHealth({ valid: true, latencyMs: PROVIDER_DEGRADED_LATENCY_MS + 1 }).status).toBe(
      'degraded'
    );
  });

  it('treats rate limiting as degraded and still reachable', () => {
    // The provider answered and the credential works; it is only throttled.
    expect(deriveHealth(failed('rate_limited'))).toMatchObject({
      status: 'degraded',
      reachable: true,
      rateLimited: true,
    });
  });

  it.each(['forbidden', 'misconfigured'] as const)('reports %s as unknown, not unhealthy', (f) => {
    // Nothing was learned about the provider, so an alarm would be false.
    expect(deriveHealth(failed(f)).status).toBe('unknown');
  });

  it('is unhealthy when the provider rejects or cannot be reached', () => {
    expect(deriveHealth(failed('unauthorized')).status).toBe('unhealthy');
    expect(deriveHealth(failed('network_error')).status).toBe('unhealthy');
  });
});

describe('classifyOutcome', () => {
  const healthy = deriveHealth({ valid: true, latencyMs: 1 });
  const okLimits = { ...noLimits('unsupported', 'none'), requestsLimit: available(10) };

  it('is a success when everything the provider offers was collected', () => {
    expect(classifyOutcome(healthy, okLimits, { supported: true, entries: [] })).toBe('success');
  });

  it('is a success when the provider simply has no usage API', () => {
    // Exposing little is not the same as going wrong.
    expect(
      classifyOutcome(healthy, okLimits, {
        supported: false,
        reason: 'unsupported',
        detail: 'no usage endpoint',
      })
    ).toBe('success');
  });

  it('is partial when usage failed', () => {
    expect(
      classifyOutcome(healthy, okLimits, {
        supported: false,
        reason: 'provider_error',
        detail: 'HTTP 500',
      })
    ).toBe('partial');
  });

  it('is partial when limits failed', () => {
    const broken = noLimits('provider_error', 'HTTP 500');

    expect(classifyOutcome(healthy, broken, { supported: true, entries: [] })).toBe('partial');
    expect(limitsErrored(broken)).toBe(true);
  });

  it('is failed when the provider is unhealthy', () => {
    expect(
      classifyOutcome(deriveHealth(failed('network_error')), okLimits, {
        supported: true,
        entries: [],
      })
    ).toBe('failed');
  });
});

describe('collectUnavailable', () => {
  it('records why usage is missing, with the provider’s own wording', () => {
    const notes = collectUnavailable(
      capabilities({ usage: 'none' }),
      noLimits('unsupported', 'x'),
      {
        supported: false,
        reason: 'requires_admin_credential',
        detail: 'Needs an admin key',
      }
    );

    expect(notes.usage).toEqual({
      reason: 'requires_admin_credential',
      detail: 'Needs an admin key',
    });
  });

  it('notes that a provider reports no cost', () => {
    const notes = collectUnavailable(capabilities({ cost: 'none' }), noLimits('unsupported', 'x'), {
      supported: true,
      entries: [],
    });

    expect(notes.cost?.reason).toBe('unsupported');
  });

  it('prefers a provider error over a permanent gap', () => {
    const limits: NormalizedLimits = {
      ...noLimits('unsupported', 'not reported'),
      tokensLimit: { available: false, reason: 'provider_error', detail: 'HTTP 503' },
    };

    const notes = collectUnavailable(capabilities(), limits, { supported: true, entries: [] });

    // An outage is actionable; a permanent gap is not.
    expect(notes.limits).toEqual({ reason: 'provider_error', detail: 'HTTP 503' });
  });

  it('says nothing when everything is available', () => {
    const limits: NormalizedLimits = {
      requestsLimit: available(1),
      requestsRemaining: available(1),
      tokensLimit: available(1),
      tokensRemaining: available(1),
      quotaUsed: available(1),
      quotaLimit: available(1),
      quotaUnit: available('tokens'),
      balance: available([{ amount: 1, currency: 'USD' }]),
      resetsAt: available(new Date()),
      rateLimited: false,
    };

    expect(collectUnavailable(capabilities(), limits, { supported: true, entries: [] })).toEqual(
      {}
    );
  });
});

describe('collectTarget', () => {
  const retry = { sleep: async () => {} };

  it('probes once and reuses limits the probe already returned', async () => {
    const limits = { ...noLimits('unsupported', 'none'), quotaLimit: available(100) };
    const fake = fakeAdapter({ validations: [{ valid: true, latencyMs: 5, limits }] });

    const collection = await collectTarget(target(), {
      adapter: fake.adapter,
      credential: CREDENTIAL,
      window: WINDOW,
      retry,
    });

    expect(fake.validateCredentials).toHaveBeenCalledTimes(1);
    // Asking again would double the requests for no new information.
    expect(fake.fetchLimits).not.toHaveBeenCalled();
    expect(collection.limits.quotaLimit).toEqual({ available: true, value: 100 });
  });

  it('fetches limits separately when the probe did not carry them', async () => {
    const fake = fakeAdapter();

    await collectTarget(target(), {
      adapter: fake.adapter,
      credential: CREDENTIAL,
      window: WINDOW,
      retry,
    });

    expect(fake.fetchLimits).toHaveBeenCalledTimes(1);
  });

  it('collects usage and exposes the normalized rows', async () => {
    const fake = fakeAdapter();

    const collection = await collectTarget(target(), {
      adapter: fake.adapter,
      credential: CREDENTIAL,
      window: WINDOW,
      retry,
    });

    expect(fake.fetchUsage).toHaveBeenCalledTimes(1);
    expect(collection.entries).toHaveLength(1);
    expect(collection.outcome).toBe('success');
  });

  it('does not request usage from a provider that just failed its probe', async () => {
    const fake = fakeAdapter({ validations: [failed('network_error')] });

    const collection = await collectTarget(target(), {
      adapter: fake.adapter,
      credential: CREDENTIAL,
      window: WINDOW,
      retry,
    });

    // One outage should not cost three requests per credential.
    expect(fake.fetchUsage).not.toHaveBeenCalled();
    expect(collection.outcome).toBe('failed');
    expect(collection.entries).toEqual([]);
  });

  it('counts one step per collection stage', async () => {
    const fake = fakeAdapter({
      caps: { usage: 'none' },
      usage: { supported: false, reason: 'unsupported', detail: 'no usage endpoint' },
    });

    const collection = await collectTarget(target(), {
      adapter: fake.adapter,
      credential: CREDENTIAL,
      window: WINDOW,
      retry,
    });

    // Probe, limits and usage: one step each, none needing a retry.
    expect(collection.attempts).toBe(3);
    expect(collection.outcome).toBe('success');
  });

  it('retries a transient probe failure and then succeeds', async () => {
    const fake = fakeAdapter({
      validations: [failed('network_error'), { valid: true, latencyMs: 8 }],
    });

    const collection = await collectTarget(target(), {
      adapter: fake.adapter,
      credential: CREDENTIAL,
      window: WINDOW,
      retry,
    });

    expect(fake.validateCredentials).toHaveBeenCalledTimes(2);
    expect(collection.health.status).toBe('healthy');
  });

  it('does not retry a rejected credential', async () => {
    const fake = fakeAdapter({ validations: [failed('unauthorized', 'Invalid API key')] });

    const collection = await collectTarget(target(), {
      adapter: fake.adapter,
      credential: CREDENTIAL,
      window: WINDOW,
      retry,
    });

    expect(fake.validateCredentials).toHaveBeenCalledTimes(1);
    expect(collection.credentialOutcome).toBe('invalid');
  });

  it('leaves the credential unverified when the provider is merely unavailable', async () => {
    const fake = fakeAdapter({ validations: [failed('timeout')] });

    const collection = await collectTarget(target(), {
      adapter: fake.adapter,
      credential: CREDENTIAL,
      window: WINDOW,
      retry,
    });

    // A provider outage must not mark a good key as rejected.
    expect(collection.credentialOutcome).toBe('unverified');
  });
});

describe('runCollection', () => {
  interface HarnessOptions {
    targets?: CollectionTarget[];
    adapter?: AIProviderAdapter;
    adapterFor?: (type: AiProviderType) => AIProviderAdapter;
    credential?: ProviderCredential | { error: string } | null;
    sink?: UsageSink;
    lock?: { release: () => Promise<void> } | null;
  }

  function harness(options: HarnessOptions = {}) {
    const records: CollectorRunRecord[] = [];
    const checks: { apiKeyId: string; outcome: string }[] = [];
    const release = vi.fn(async () => {});
    const lock = options.lock === null ? null : (options.lock ?? { release });
    const acquireLock = vi.fn(async () => lock);
    const fallback = options.adapter ?? fakeAdapter().adapter;

    return {
      records,
      checks,
      release,
      acquireLock,
      run: () =>
        runCollection({
          retry: { sleep: async () => {} },
          listTargets: async () => options.targets ?? [target()],
          loadCredential: async () =>
            options.credential === undefined ? CREDENTIAL : options.credential,
          adapterFor: options.adapterFor ?? (() => fallback),
          recordRun: async (record) => {
            records.push(record);
          },
          saveCredentialCheck: async (t, outcome) => {
            checks.push({ apiKeyId: t.apiKeyId, outcome });
          },
          acquireLock,
          // Never the default sink: a unit test must not reach a database.
          sink: options.sink ?? discardingUsageSink,
        }),
    };
  }

  it('does nothing when another collection holds the lock', async () => {
    const h = harness({ lock: null });

    const summary = await h.run();

    // Two runs at once would call every provider twice and double any storage.
    expect(summary.ran).toBe(false);
    expect(summary.targets).toBe(0);
    expect(h.records).toHaveLength(0);
    expect(summary.problems[0]).toMatch(/already running/);
  });

  it('releases the lock even when listing targets fails', async () => {
    const release = vi.fn(async () => {});

    await expect(
      runCollection({
        acquireLock: async () => ({ release }),
        listTargets: async () => {
          throw new Error('database down');
        },
      })
    ).rejects.toThrow('database down');

    // A stuck lock would block every later run.
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('records a run and updates the credential check for each target', async () => {
    const h = harness();

    const summary = await h.run();

    expect(summary).toMatchObject({ ran: true, targets: 1, success: 1, usageEntries: 1 });
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({
      apiKeyId: 'key-1',
      outcome: 'success',
      providerStatus: 'healthy',
      usageEntryCount: 1,
      usagePersistedCount: 0,
    });
    expect(h.checks).toEqual([{ apiKeyId: 'key-1', outcome: 'valid' }]);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('reports what a sink stored, separately from what was collected', async () => {
    const sink: UsageSink = {
      name: 'test',
      write: vi.fn(async () => ({ stored: 7, skipped: 0, notes: [] })),
    };
    const h = harness({ sink });

    const summary = await h.run();

    expect(summary.usageEntries).toBe(1);
    expect(summary.usagePersisted).toBe(7);
    expect(h.records[0].usagePersistedCount).toBe(7);
  });

  it('surfaces a sink note so unstored usage is never silent', async () => {
    const sink: UsageSink = {
      name: 'test',
      write: async () => ({ stored: 0, skipped: 1, notes: ['key "sk-other" is not registered'] }),
    };
    const h = harness({ sink });

    const summary = await h.run();

    expect(summary.usageEntries).toBe(1);
    expect(summary.usagePersisted).toBe(0);
    expect(summary.problems).toContain('key "sk-other" is not registered');
  });

  it('skips a credential that disappeared mid-run', async () => {
    const h = harness({ credential: null });

    const summary = await h.run();

    expect(summary.skipped).toBe(1);
    expect(h.records).toHaveLength(0);
  });

  it('records a decryption failure as a failed run', async () => {
    const h = harness({ credential: { error: 'encrypted with a key that is not configured' } });

    const summary = await h.run();

    expect(summary.failed).toBe(1);
    expect(h.records[0]).toMatchObject({ outcome: 'failed', providerStatus: 'unknown' });
    expect(summary.problems[0]).toMatch(/not configured/);
  });

  it('contains a crashing adapter so other providers still collect', async () => {
    const exploding: AIProviderAdapter = {
      ...fakeAdapter().adapter,
      validateCredentials: async () => {
        throw new Error('adapter defect');
      },
    };
    const working = fakeAdapter().adapter;

    const summary = await runCollection({
      retry: { sleep: async () => {} },
      listTargets: async () => [
        target({ providerType: 'openai', providerName: 'OpenAI', apiKeyId: 'k1' }),
        target({ providerType: 'anthropic', providerName: 'Anthropic', apiKeyId: 'k2' }),
      ],
      loadCredential: async () => CREDENTIAL,
      adapterFor: (type) => (type === 'openai' ? exploding : working),
      recordRun: async () => {},
      saveCredentialCheck: async () => {},
      acquireLock: async () => ({ release: async () => {} }),
      sink: discardingUsageSink,
    });

    expect(summary.failed).toBe(1);
    expect(summary.success).toBe(1);
    expect(summary.byProvider.Anthropic).toMatchObject({ success: 1 });
  });

  it('collects one provider’s credentials in sequence', async () => {
    let inFlight = 0;
    let peak = 0;

    const slow: AIProviderAdapter = {
      ...fakeAdapter().adapter,
      validateCredentials: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { valid: true, latencyMs: 1 };
      },
    };

    await runCollection({
      retry: { sleep: async () => {} },
      listTargets: async () =>
        Array.from({ length: 4 }, (_unused, index) => target({ apiKeyId: `key-${index}` })),
      loadCredential: async () => CREDENTIAL,
      adapterFor: () => slow,
      recordRun: async () => {},
      saveCredentialCheck: async () => {},
      acquireLock: async () => ({ release: async () => {} }),
      sink: discardingUsageSink,
    });

    // Serialised per provider, so the collector does not trigger the very rate
    // limits it is measuring.
    expect(peak).toBe(1);
  });

  it('summarises per provider', async () => {
    const summary = await runCollection({
      retry: { sleep: async () => {} },
      listTargets: async () => [
        target({ providerName: 'OpenAI', providerType: 'openai', apiKeyId: 'k1' }),
        target({ providerName: 'OpenAI', providerType: 'openai', apiKeyId: 'k2' }),
        target({ providerName: 'Groq', providerType: 'groq', apiKeyId: 'k3' }),
      ],
      loadCredential: async () => CREDENTIAL,
      adapterFor: () => fakeAdapter().adapter,
      recordRun: async () => {},
      saveCredentialCheck: async () => {},
      acquireLock: async () => ({ release: async () => {} }),
      sink: discardingUsageSink,
    });

    expect(summary.byProvider.OpenAI).toMatchObject({ targets: 2, success: 2 });
    expect(summary.byProvider.Groq).toMatchObject({ targets: 1, success: 1 });
  });
});
