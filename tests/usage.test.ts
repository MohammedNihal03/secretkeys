import { describe, expect, it } from 'vitest';

import type { CollectionTarget, UsageWriteContext } from '@/lib/collector/types';
import { available, providerError, unsupported, type NormalizedUsage } from '@/lib/providers/types';
import { attributeEntries, type KeyDirectory } from '@/lib/usage/attribution';
import {
  hasReportedMetric,
  mergeIntervals,
  toUsageRow,
  USAGE_METRIC_FIELDS,
  type UsageRowInput,
} from '@/lib/usage/normalize';
import { createDatabaseUsageSink } from '@/lib/usage/sink';

/**
 * Usage storage, without a database.
 *
 * What is tested here is the part that decides *what a stored number means*:
 * which credential a row belongs to, when a missing metric is null rather than
 * zero, and how a provider's split intervals combine. Those are the decisions
 * that would silently corrupt a time series, and none of them need Postgres.
 */

const CONTEXT: UsageWriteContext = {
  collectedAt: new Date('2026-09-12T10:00:00Z'),
  latencyMs: 240,
};

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

function entry(overrides: Partial<NormalizedUsage> = {}): NormalizedUsage {
  return {
    windowStart: new Date('2026-09-11T00:00:00Z'),
    windowEnd: new Date('2026-09-12T00:00:00Z'),
    requests: available(120),
    successfulRequests: unsupported('Not split by outcome'),
    failedRequests: unsupported('Not split by outcome'),
    inputTokens: available(1_000),
    outputTokens: available(500),
    totalTokens: available(1_500),
    characters: unsupported('Not metered'),
    audioSeconds: unsupported('Not metered'),
    estimatedCostUsd: available(1.23456789),
    ...overrides,
  };
}

const SELF = { apiKeyId: 'key-1', projectId: 'project-1' };

describe('toUsageRow', () => {
  it('stores what the provider reported and nulls what it did not', () => {
    const row = toUsageRow(entry(), target(), SELF, CONTEXT);

    expect(row).toMatchObject({
      organizationId: 'org-1',
      projectId: 'project-1',
      providerId: 'provider-1',
      apiKeyId: 'key-1',
      timestamp: new Date('2026-09-11T00:00:00Z'),
      windowEnd: new Date('2026-09-12T00:00:00Z'),
      requests: 120,
      inputTokens: 1_000,
      outputTokens: 500,
      totalTokens: 1_500,
      latencyMs: 240,
    });

    // Never zero: a provider that does not split by outcome has not told us
    // that every request succeeded.
    expect(row.successfulRequests).toBeNull();
    expect(row.characters).toBeNull();
  });

  it('keeps the reason a metric is missing', () => {
    const row = toUsageRow(
      entry({ estimatedCostUsd: providerError('The cost endpoint returned 500.') }),
      target(),
      SELF,
      CONTEXT
    );

    expect(row.estimatedCost).toBeNull();
    expect(row.unavailable?.estimatedCost).toEqual({
      reason: 'provider_error',
      detail: 'The cost endpoint returned 500.',
    });
    // A reason must never be recorded for a metric that does have a value.
    expect(row.unavailable?.requests).toBeUndefined();
  });

  it('records the metrics no adapter reports yet as unsupported, not zero', () => {
    const row = toUsageRow(entry(), target(), SELF, CONTEXT);

    expect(row.errorCount).toBeNull();
    expect(row.rateLimitCount).toBeNull();
    expect(row.unavailable?.errorCount.reason).toBe('unsupported');
    expect(row.unavailable?.rateLimitCount.reason).toBe('unsupported');
  });

  it('keeps cost exact and rounds counters to whole units', () => {
    const row = toUsageRow(
      entry({ requests: available(12.6), audioSeconds: available(90.4) }),
      target(),
      SELF,
      CONTEXT
    );

    expect(row.estimatedCost).toBe(1.23456789);
    expect(row.requests).toBe(13);
    expect(row.audioSeconds).toBe(90);
  });

  it('refuses a value that is not a finite number', () => {
    const row = toUsageRow(entry({ totalTokens: available(Number.NaN) }), target(), SELF, CONTEXT);

    // One poisoned row would make every sum over the column NaN.
    expect(row.totalTokens).toBeNull();
    expect(row.unavailable?.totalTokens.reason).toBe('provider_error');
  });

  it('attributes the row to the project of the key it was mapped to', () => {
    const row = toUsageRow(
      entry(),
      target(),
      { apiKeyId: 'key-2', projectId: 'project-2' },
      CONTEXT
    );

    expect(row).toMatchObject({ apiKeyId: 'key-2', projectId: 'project-2' });
  });
});

describe('hasReportedMetric', () => {
  it('rejects an interval in which nothing was reported', () => {
    const row = toUsageRow(
      entry(
        Object.fromEntries(
          [
            'requests',
            'successfulRequests',
            'failedRequests',
            'inputTokens',
            'outputTokens',
            'totalTokens',
            'characters',
            'audioSeconds',
          ].map((field) => [field, unsupported('Not reported')])
        ) as Partial<NormalizedUsage>
      ),
      target(),
      SELF,
      CONTEXT
    );

    expect(hasReportedMetric({ ...row, estimatedCost: null })).toBe(false);
    // A reported zero is a fact and must be kept.
    expect(hasReportedMetric({ ...row, requests: 0 })).toBe(true);
  });

  it('covers every metric column the build plan lists', () => {
    expect(USAGE_METRIC_FIELDS).toEqual([
      'requests',
      'successfulRequests',
      'failedRequests',
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'characters',
      'audioSeconds',
      'estimatedCost',
      'errorCount',
      'rateLimitCount',
    ]);
  });
});

describe('mergeIntervals', () => {
  function row(overrides: Partial<UsageRowInput>): UsageRowInput {
    return { ...toUsageRow(entry(), target(), SELF, CONTEXT), ...overrides };
  }

  it('sums rows describing the same interval for the same key', () => {
    const merged = mergeIntervals([
      row({ requests: 10, totalTokens: 100 }),
      row({ requests: 5, totalTokens: 50 }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ requests: 15, totalTokens: 150 });
  });

  it('keeps a value reported by only one of the split rows', () => {
    const merged = mergeIntervals([
      row({
        characters: null,
        unavailable: { characters: { reason: 'unsupported', detail: 'x' } },
      }),
      row({ characters: 400, unavailable: null }),
    ]);

    expect(merged[0].characters).toBe(400);
    // The value arrived, so the "missing" note must go.
    expect(merged[0].unavailable?.characters).toBeUndefined();
  });

  it('leaves a metric no row reported null, with its reason', () => {
    const note = { reason: 'unsupported', detail: 'Not metered' };
    const merged = mergeIntervals([
      row({ characters: null, unavailable: { characters: note } }),
      row({ characters: null, unavailable: { characters: note } }),
    ]);

    expect(merged[0].characters).toBeNull();
    expect(merged[0].unavailable?.characters).toEqual(note);
  });

  it('preserves every original payload when rows merge', () => {
    const merged = mergeIntervals([
      row({ providerRaw: { model: 'gpt-4o' } }),
      row({ providerRaw: { model: 'gpt-4o-mini' } }),
    ]);

    expect(merged[0].providerRaw).toEqual({
      parts: [{ model: 'gpt-4o' }, { model: 'gpt-4o-mini' }],
    });
  });

  it('does not merge different intervals or different keys', () => {
    const merged = mergeIntervals([
      row({}),
      row({ windowEnd: new Date('2026-09-12T12:00:00Z') }),
      row({ apiKeyId: 'key-2' }),
    ]);

    expect(merged).toHaveLength(3);
  });
});

describe('attributeEntries', () => {
  const directory: KeyDirectory = new Map([
    ['key_self', { apiKeyId: 'key-1', projectId: 'project-1' }],
    ['key_other', { apiKeyId: 'key-2', projectId: 'project-2' }],
  ]);

  it('attributes an unlabelled row to the credential that fetched it', () => {
    const result = attributeEntries(target(), [entry()], directory);

    expect(result.attributed).toHaveLength(1);
    expect(result.attributed[0].attribution).toEqual(SELF);
    expect(result.skipped).toBe(0);
  });

  it('routes a labelled row to the key the provider named', () => {
    const result = attributeEntries(target(), [entry({ providerKeyId: 'key_other' })], directory);

    // Another team's spend must land on their project, not on the one whose
    // credential happened to make the request.
    expect(result.attributed[0].attribution).toEqual({
      apiKeyId: 'key-2',
      projectId: 'project-2',
    });
  });

  it('drops usage for an unregistered key rather than misattributing it', () => {
    const result = attributeEntries(
      target(),
      [entry({ providerKeyId: 'key_unknown' }), entry({ providerKeyId: 'key_unknown' })],
      directory
    );

    expect(result.attributed).toHaveLength(0);
    expect(result.skipped).toBe(2);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain('key_unknown');
    expect(result.notes[0]).toContain('2 intervals were not stored');
  });
});

describe('the database usage sink', () => {
  function sinkWith(directory: KeyDirectory) {
    const saved: UsageRowInput[][] = [];

    const sink = createDatabaseUsageSink({
      loadDirectory: async () => directory,
      save: async (rows) => {
        saved.push([...rows]);
        return rows.length;
      },
    });

    return { sink, saved };
  }

  it('stores nothing and asks nothing of the database for an empty collection', async () => {
    const { sink, saved } = sinkWith(new Map());

    const result = await sink.write(target(), [], CONTEXT);

    expect(result).toEqual({ stored: 0, skipped: 0, notes: [] });
    expect(saved).toHaveLength(0);
  });

  it('merges a provider split before writing, and counts intervals not entries', async () => {
    const { sink, saved } = sinkWith(new Map());

    const result = await sink.write(
      target(),
      [entry({ requests: available(10) }), entry({ requests: available(4) })],
      CONTEXT
    );

    expect(saved[0]).toHaveLength(1);
    expect(saved[0][0].requests).toBe(14);
    // Two entries became one stored interval, and neither was skipped.
    expect(result).toMatchObject({ stored: 1, skipped: 0 });
  });

  it('reports usage it could not attribute instead of dropping it silently', async () => {
    const { sink, saved } = sinkWith(new Map());

    const result = await sink.write(target(), [entry({ providerKeyId: 'key_ghost' })], CONTEXT);

    expect(saved[0]).toHaveLength(0);
    expect(result.stored).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.notes[0]).toContain('key_ghost');
  });

  it('does not write an interval in which the provider reported nothing', async () => {
    const { sink, saved } = sinkWith(new Map());

    const nothing = entry({
      requests: unsupported('Not reported'),
      inputTokens: unsupported('Not reported'),
      outputTokens: unsupported('Not reported'),
      totalTokens: unsupported('Not reported'),
      estimatedCostUsd: unsupported('Not reported'),
    });

    const result = await sink.write(target(), [nothing], CONTEXT);

    // "Do not create data simply because the UI refreshes."
    expect(saved[0]).toHaveLength(0);
    expect(result.stored).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.notes[0]).toContain('no metric');
  });
});
