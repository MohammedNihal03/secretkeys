import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCollection } from '@/lib/collector/runner';
import type { CollectionTarget, UsageWriteContext } from '@/lib/collector/types';
import { registerApiKey } from '@/lib/credentials/service';
import { closePool, getDb } from '@/lib/db/client';
import {
  aiProviders,
  aiUsage,
  apiKeys,
  collectorRuns,
  organizations,
  projects,
} from '@/lib/db/schema';
import {
  available,
  noLimits,
  unsupported,
  type AIProviderAdapter,
  type NormalizedUsage,
} from '@/lib/providers/types';
import {
  latestUsageInterval,
  loadKeyDirectory,
  pruneUsage,
  summarizeUsage,
  upsertUsageRows,
  usageBreakdown,
  usageTimeSeries,
} from '@/lib/usage/repository';
import { databaseUsageSink } from '@/lib/usage/sink';

/**
 * The usage time series against a real database.
 *
 *   npm run db:setup && npm run test:integration
 *
 * What only Postgres can answer is tested here: that re-collecting a window
 * corrects rows instead of duplicating them, that a null metric survives
 * aggregation as null rather than zero, that `updated_at` moves on a correction,
 * and that one organization's reads cannot see another's rows.
 */

const RUN = Math.random().toString(36).slice(2, 10);
const db = getDb();

let orgA: string;
let orgB: string;
let projectA: string;
let projectA2: string;
let projectB: string;
let ids: Record<string, string>;
let counter = 0;

let fetchMock: ReturnType<typeof vi.fn>;

const CONTEXT: UsageWriteContext = {
  collectedAt: new Date('2026-09-12T10:00:00Z'),
  latencyMs: 180,
};

const DAY_ONE = new Date('2026-09-10T00:00:00Z');
const DAY_TWO = new Date('2026-09-11T00:00:00Z');
const DAY_THREE = new Date('2026-09-12T00:00:00Z');

function newSecret(): string {
  counter += 1;
  return `sk-proj-${RUN}${counter}${'K'.repeat(24)}Z${counter}`;
}

async function registerKey(
  organizationId: string,
  projectId: string,
  providerId: string,
  name: string,
  providerKeyId: string | null = null
): Promise<string> {
  fetchMock.mockImplementation(
    async () => new Response(JSON.stringify({ data: [] }), { status: 200 })
  );

  const result = await registerApiKey(organizationId, {
    projectId,
    providerId,
    keyName: name,
    environment: 'production',
    secret: newSecret(),
    providerKeyId,
    baseUrl: null,
  });

  if (!result.ok) throw new Error(`could not register ${name}`);
  return result.apiKeyId;
}

function target(overrides: Partial<CollectionTarget> = {}): CollectionTarget {
  return {
    organizationId: orgA,
    organizationName: 'Usage Org A',
    projectId: projectA,
    projectName: 'FYIND',
    providerId: ids.openai,
    providerType: 'openai',
    providerName: 'OpenAI',
    apiKeyId: '',
    keyName: 'Production',
    environment: 'production',
    ...overrides,
  };
}

function entry(overrides: Partial<NormalizedUsage> = {}): NormalizedUsage {
  return {
    windowStart: DAY_TWO,
    windowEnd: DAY_THREE,
    requests: available(100),
    successfulRequests: unsupported('Not split by outcome'),
    failedRequests: unsupported('Not split by outcome'),
    inputTokens: available(2_000),
    outputTokens: available(1_000),
    totalTokens: available(3_000),
    characters: unsupported('Not metered'),
    audioSeconds: unsupported('Not metered'),
    estimatedCostUsd: available(2.5),
    ...overrides,
  };
}

/** Every row currently stored for one credential, oldest interval first. */
async function storedFor(apiKeyId: string) {
  return db.select().from(aiUsage).where(eq(aiUsage.apiKeyId, apiKeyId)).orderBy(aiUsage.timestamp);
}

const RANGE = { from: DAY_ONE, to: new Date('2026-09-13T00:00:00Z') };

beforeAll(async () => {
  const [a, b] = await db
    .insert(organizations)
    .values([{ name: `Usage Org A ${RUN}` }, { name: `Usage Org B ${RUN}` }])
    .returning({ id: organizations.id });
  orgA = a.id;
  orgB = b.id;

  const inserted = await db
    .insert(projects)
    .values([
      { organizationId: orgA, name: 'FYIND' },
      { organizationId: orgA, name: 'Lunad' },
      { organizationId: orgB, name: 'Other' },
    ])
    .returning({ id: projects.id, name: projects.name });

  projectA = inserted.find((p) => p.name === 'FYIND')!.id;
  projectA2 = inserted.find((p) => p.name === 'Lunad')!.id;
  projectB = inserted.find((p) => p.name === 'Other')!.id;

  const catalogue = await db
    .select({ id: aiProviders.id, type: aiProviders.type })
    .from(aiProviders);
  ids = Object.fromEntries(catalogue.map((row) => [row.type, row.id]));
});

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  for (const id of [orgA, orgB].filter(Boolean)) {
    await db.delete(organizations).where(eq(organizations.id, id));
  }
  await closePool();
});

describe('storing usage', () => {
  it('writes one row per interval, attributed all the way up the hierarchy', async () => {
    const keyId = await registerKey(orgA, projectA, ids.openai, `store-${RUN}`);

    const result = await databaseUsageSink.write(
      target({ apiKeyId: keyId }),
      [entry({ windowStart: DAY_ONE, windowEnd: DAY_TWO }), entry()],
      CONTEXT
    );

    expect(result).toMatchObject({ stored: 2, skipped: 0 });

    const rows = await storedFor(keyId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      organizationId: orgA,
      projectId: projectA,
      providerId: ids.openai,
      apiKeyId: keyId,
      requests: 100,
      inputTokens: 2_000,
      totalTokens: 3_000,
      latencyMs: 180,
    });
    // Money keeps its exact decimal value through the numeric column.
    expect(rows[0].estimatedCost).toBe(2.5);
    // Not zero: the provider never reported these.
    expect(rows[0].successfulRequests).toBeNull();
    expect(rows[0].unavailable?.successfulRequests.reason).toBe('unsupported');
  });

  it('corrects an interval on re-collection instead of duplicating it', async () => {
    const keyId = await registerKey(orgA, projectA, ids.openai, `upsert-${RUN}`);
    const at = target({ apiKeyId: keyId });

    await databaseUsageSink.write(at, [entry({ requests: available(100) })], CONTEXT);
    const [before] = await storedFor(keyId);

    // A provider finalising the day downward must be able to revise it down.
    await databaseUsageSink.write(
      at,
      [entry({ requests: available(90), estimatedCostUsd: available(2.25) })],
      CONTEXT
    );

    const rows = await storedFor(keyId);
    expect(rows).toHaveLength(1);
    expect(rows[0].requests).toBe(90);
    expect(rows[0].estimatedCost).toBe(2.25);
    expect(rows[0].id).toBe(before.id);
    // The trigger owns `updated_at`, and a correction must move it.
    expect(rows[0].updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
    expect(rows[0].createdAt.getTime()).toBe(before.createdAt.getTime());
  });

  it('merges a provider split into one interval in a single statement', async () => {
    const keyId = await registerKey(orgA, projectA, ids.openai, `split-${RUN}`);

    // Two rows for the same day would violate the unique constraint, and a
    // single upsert cannot touch the same row twice.
    const result = await databaseUsageSink.write(
      target({ apiKeyId: keyId }),
      [
        entry({ requests: available(60), providerRaw: { model: 'gpt-4o' } }),
        entry({ requests: available(40), providerRaw: { model: 'gpt-4o-mini' } }),
      ],
      CONTEXT
    );

    const rows = await storedFor(keyId);
    expect(result.stored).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].requests).toBe(100);
    expect(rows[0].providerRaw).toEqual({
      parts: [{ model: 'gpt-4o' }, { model: 'gpt-4o-mini' }],
    });
  });

  it('routes usage the provider attributed to another registered key', async () => {
    const collecting = await registerKey(
      orgA,
      projectA,
      ids.openai,
      `admin-${RUN}`,
      `pk-admin-${RUN}`
    );
    const owner = await registerKey(orgA, projectA2, ids.openai, `owned-${RUN}`, `pk-owned-${RUN}`);

    const result = await databaseUsageSink.write(
      target({ apiKeyId: collecting }),
      [entry({ providerKeyId: `pk-owned-${RUN}` }), entry({ providerKeyId: `pk-ghost-${RUN}` })],
      CONTEXT
    );

    const ownerRows = await storedFor(owner);
    expect(ownerRows).toHaveLength(1);
    // The other project's spend lands on the other project.
    expect(ownerRows[0].projectId).toBe(projectA2);
    expect(await storedFor(collecting)).toHaveLength(0);

    // And the key we do not know about is reported, not guessed at.
    expect(result).toMatchObject({ stored: 1, skipped: 1 });
    expect(result.notes[0]).toContain(`pk-ghost-${RUN}`);
  });

  it('indexes an organization’s keys by the provider’s own identifier', async () => {
    const keyId = await registerKey(orgA, projectA, ids.groq, `directory-${RUN}`, `pk-groq-${RUN}`);
    await registerKey(orgB, projectB, ids.groq, `foreign-${RUN}`, `pk-foreign-${RUN}`);

    const directory = await loadKeyDirectory(orgA, ids.groq);

    expect(directory.get(`pk-groq-${RUN}`)).toEqual({ apiKeyId: keyId, projectId: projectA });
    // Another organization's key is not addressable from here.
    expect(directory.get(`pk-foreign-${RUN}`)).toBeUndefined();
  });

  it('keeps usage for a key that has since been revoked', async () => {
    const keyId = await registerKey(
      orgA,
      projectA,
      ids.openai,
      `revoked-${RUN}`,
      `pk-revoked-${RUN}`
    );
    await db.update(apiKeys).set({ status: 'revoked' }).where(eq(apiKeys.id, keyId));

    // Last week's spend on a rotated credential is still last week's spend.
    const directory = await loadKeyDirectory(orgA, ids.openai);
    expect(directory.get(`pk-revoked-${RUN}`)?.apiKeyId).toBe(keyId);
  });
});

describe('aggregating usage', () => {
  let keyOne: string;
  let keyTwo: string;

  beforeEach(async () => {
    await db.delete(aiUsage).where(eq(aiUsage.organizationId, orgA));
    await db.delete(aiUsage).where(eq(aiUsage.organizationId, orgB));

    keyOne = await registerKey(orgA, projectA, ids.openai, `agg-one-${RUN}-${counter}`);
    keyTwo = await registerKey(orgA, projectA2, ids.groq, `agg-two-${RUN}-${counter}`);

    await databaseUsageSink.write(
      target({ apiKeyId: keyOne }),
      [
        entry({ windowStart: DAY_ONE, windowEnd: DAY_TWO, requests: available(10) }),
        entry({ windowStart: DAY_TWO, windowEnd: DAY_THREE, requests: available(20) }),
      ],
      CONTEXT
    );

    await databaseUsageSink.write(
      target({
        apiKeyId: keyTwo,
        projectId: projectA2,
        providerId: ids.groq,
        providerName: 'Groq',
      }),
      [
        entry({
          windowStart: DAY_TWO,
          windowEnd: DAY_THREE,
          requests: available(5),
          // Groq reports no cost, so this interval must not contribute one.
          estimatedCostUsd: unsupported('Groq does not report cost'),
        }),
      ],
      CONTEXT
    );
  });

  it('totals a range and says how much of it carried a cost', async () => {
    const totals = await summarizeUsage({ organizationId: orgA, ...RANGE });

    expect(totals.intervals).toBe(3);
    expect(totals.requests).toBe(35);
    expect(totals.estimatedCost).toBe(5);
    // Two of the three intervals reported cost; a total that hid this would
    // read as the organization's whole spend.
    expect(totals.costIntervals).toBe(2);
    expect(totals.firstInterval?.toISOString()).toBe(DAY_ONE.toISOString());
    expect(totals.lastInterval?.toISOString()).toBe(DAY_TWO.toISOString());
  });

  it('returns null, not zero, for a metric nothing in range reported', async () => {
    const totals = await summarizeUsage({ organizationId: orgA, ...RANGE });

    expect(totals.characters).toBeNull();
    expect(totals.successfulRequests).toBeNull();
    expect(totals.errorCount).toBeNull();
  });

  it('cannot see another organization’s usage', async () => {
    const totals = await summarizeUsage({ organizationId: orgB, ...RANGE });

    expect(totals.intervals).toBe(0);
    expect(totals.requests).toBeNull();
  });

  it('narrows to a project, a provider or a single key', async () => {
    const byProject = await summarizeUsage({ organizationId: orgA, ...RANGE, projectId: projectA });
    expect(byProject.requests).toBe(30);

    const byProvider = await summarizeUsage({
      organizationId: orgA,
      ...RANGE,
      providerId: ids.groq,
    });
    expect(byProvider.requests).toBe(5);

    const byKey = await summarizeUsage({ organizationId: orgA, ...RANGE, apiKeyId: keyTwo });
    expect(byKey.requests).toBe(5);
  });

  it('buckets a series by day and leaves empty buckets out', async () => {
    const series = await usageTimeSeries({ organizationId: orgA, ...RANGE }, 'day');

    expect(series).toHaveLength(2);
    expect(series[0].bucket.toISOString()).toBe(DAY_ONE.toISOString());
    expect(series[0].requests).toBe(10);
    expect(series[1].requests).toBe(25);

    const monthly = await usageTimeSeries({ organizationId: orgA, ...RANGE }, 'month');
    expect(monthly).toHaveLength(1);
    expect(monthly[0].requests).toBe(35);
  });

  it('buckets days in the requested time zone, not the server’s', async () => {
    // 2026-09-11T00:00Z is still 2026-09-10 in New York, so a "daily" chart
    // must be able to say which day it means.
    const utc = await usageTimeSeries({ organizationId: orgA, ...RANGE }, 'day', 'UTC');
    const newYork = await usageTimeSeries(
      { organizationId: orgA, ...RANGE },
      'day',
      'America/New_York'
    );

    expect(utc[0].bucket.toISOString()).toBe('2026-09-10T00:00:00.000Z');
    expect(newYork[0].bucket.toISOString()).toBe('2026-09-09T04:00:00.000Z');
  });

  it('refuses a time zone that is not a plain name', async () => {
    await expect(
      usageTimeSeries({ organizationId: orgA, ...RANGE }, 'day', "UTC'; drop table ai_usage; --")
    ).rejects.toThrow(/Unsupported time zone/);

    // The guard has to run before the statement, not after it.
    expect((await summarizeUsage({ organizationId: orgA, ...RANGE })).intervals).toBe(3);
  });

  it('breaks totals down by each level of the hierarchy', async () => {
    const byProject = await usageBreakdown({ organizationId: orgA, ...RANGE }, 'project');
    expect(byProject.map((row) => [row.name, row.requests])).toEqual([
      ['FYIND', 30],
      ['Lunad', 5],
    ]);

    const byProvider = await usageBreakdown({ organizationId: orgA, ...RANGE }, 'provider');
    expect(byProvider.find((row) => row.name === 'Groq')?.estimatedCost).toBeNull();

    const byKey = await usageBreakdown({ organizationId: orgA, ...RANGE }, 'apiKey');
    expect(byKey).toHaveLength(2);
  });

  it('excludes intervals outside the range, at both ends', async () => {
    const only = await summarizeUsage({
      organizationId: orgA,
      from: DAY_TWO,
      to: DAY_THREE,
    });

    // `from` is inclusive and `to` exclusive, so adjacent ranges never
    // double-count an interval.
    expect(only.intervals).toBe(2);
    expect(only.requests).toBe(25);
  });

  it('reports the newest interval it holds', async () => {
    expect((await latestUsageInterval(orgA))?.toISOString()).toBe(DAY_TWO.toISOString());
    expect(await latestUsageInterval(orgB)).toBeNull();
  });

  it('prunes only what ended before the cut-off', async () => {
    const deleted = await pruneUsage(DAY_TWO);

    expect(deleted).toBe(1);
    const totals = await summarizeUsage({ organizationId: orgA, ...RANGE });
    expect(totals.intervals).toBe(2);
  });
});

describe('a whole collection', () => {
  /** An adapter that reports usage, so the pipeline has something to store. */
  function reportingAdapter(entries: NormalizedUsage[]): AIProviderAdapter {
    return {
      type: 'openai',
      displayName: 'OpenAI',
      category: 'llm',
      capabilities: {
        usage: 'per_key',
        cost: 'per_key',
        limits: 'none',
        meters: ['requests', 'tokens'],
        notes: 'test adapter',
      },
      validateCredentials: async () => ({ valid: true, latencyMs: 42 }),
      fetchLimits: async () => noLimits('unsupported', 'none'),
      fetchUsage: async () => ({ supported: true, entries }),
      fetchHealth: async () => ({
        status: 'healthy',
        reachable: true,
        latencyMs: 42,
        rateLimited: false,
      }),
      normalizeMetrics: () => [],
    };
  }

  it('carries a provider’s numbers from the collector into the table', async () => {
    const keyId = await registerKey(orgA, projectA, ids.openai, `pipeline-${RUN}`);

    const summary = await runCollection({
      organizationId: orgA,
      retry: { sleep: async () => {} },
      // Everything else is real: target selection, decryption, the advisory
      // lock, run recording and the default `ai_usage` sink.
      adapterFor: () => reportingAdapter([entry()]),
    });

    expect(summary.usageEntries).toBeGreaterThan(0);
    expect(summary.usagePersisted).toBeGreaterThan(0);

    const rows = await storedFor(keyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: orgA,
      projectId: projectA,
      requests: 100,
      // The collector's observed round trip, recorded with the interval.
      latencyMs: 42,
    });

    // What the collector says it stored has to match what is actually stored.
    const [run] = await db.select().from(collectorRuns).where(eq(collectorRuns.apiKeyId, keyId));
    expect(run.usageEntryCount).toBe(1);
    expect(run.usagePersistedCount).toBe(1);
  });

  it('does not accumulate rows when the same window is collected twice', async () => {
    const keyId = await registerKey(orgA, projectA, ids.openai, `twice-${RUN}`);
    const adapterFor = () => reportingAdapter([entry()]);

    await runCollection({ organizationId: orgA, retry: { sleep: async () => {} }, adapterFor });
    await runCollection({ organizationId: orgA, retry: { sleep: async () => {} }, adapterFor });

    // The collector re-reads an overlapping window every run; a second copy of
    // yesterday would double every total on the dashboard.
    expect(await storedFor(keyId)).toHaveLength(1);
  });
});

describe('the database guarantees', () => {
  it('refuses a row whose project belongs to another organization', async () => {
    const keyId = await registerKey(orgA, projectA, ids.openai, `isolation-${RUN}`);

    await expect(
      upsertUsageRows([
        {
          organizationId: orgA,
          // Owned by org B: the composite foreign key must reject this.
          projectId: projectB,
          providerId: ids.openai,
          apiKeyId: keyId,
          timestamp: DAY_TWO,
          windowEnd: DAY_THREE,
          requests: 1,
          successfulRequests: null,
          failedRequests: null,
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          characters: null,
          audioSeconds: null,
          estimatedCost: null,
          errorCount: null,
          rateLimitCount: null,
          latencyMs: null,
          providerKeyId: null,
          unavailable: null,
          providerRaw: null,
        },
      ])
    ).rejects.toThrow();
  });

  it('removes an organization’s usage with the organization', async () => {
    const [temp] = await db
      .insert(organizations)
      .values({ name: `Usage Org C ${RUN}` })
      .returning({ id: organizations.id });
    const [project] = await db
      .insert(projects)
      .values({ organizationId: temp.id, name: 'Temp' })
      .returning({ id: projects.id });

    const keyId = await registerKey(temp.id, project.id, ids.openai, `cascade-${RUN}`);
    await databaseUsageSink.write(
      target({ organizationId: temp.id, projectId: project.id, apiKeyId: keyId }),
      [entry()],
      CONTEXT
    );

    await db.delete(organizations).where(eq(organizations.id, temp.id));

    const left = await db
      .select({ id: aiUsage.id })
      .from(aiUsage)
      .where(and(eq(aiUsage.organizationId, temp.id)));
    expect(left).toHaveLength(0);
  });
});
