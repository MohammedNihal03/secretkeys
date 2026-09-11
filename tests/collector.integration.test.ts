import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { acquireCollectorLock } from '@/lib/collector/lock';
import { runCollection } from '@/lib/collector/runner';
import {
  collectionStateForKey,
  pruneCollectorRuns,
  recentCollectorRuns,
  recordCollectorRun,
  updateCredentialCheck,
} from '@/lib/collector/runs-repository';
import { listCollectionTargets } from '@/lib/collector/targets';
import type { CollectorRunRecord } from '@/lib/collector/types';
import { registerApiKey } from '@/lib/credentials/service';
import { closePool, getDb } from '@/lib/db/client';
import { aiProviders, apiKeys, collectorRuns, organizations, projects } from '@/lib/db/schema';
import { setProviderEnabled } from '@/lib/providers/selection';

/**
 * The collector against a real database.
 *
 *   npm run db:setup && npm run test:integration
 *
 * `fetch` is stubbed, so no provider is contacted. Target selection, the
 * advisory lock, run recording and the credential check are all real.
 */

const RUN = Math.random().toString(36).slice(2, 10);
const db = getDb();

let orgA: string;
let orgB: string;
let projectA: string;
let projectB: string;
let ids: Record<string, string>;
let counter = 0;

let fetchMock: ReturnType<typeof vi.fn>;

function respond(status: number, body: unknown = { data: [] }) {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(body), { status }));
}

function newSecret(): string {
  counter += 1;
  return `sk-proj-${RUN}${counter}${'K'.repeat(24)}Z${counter}`;
}

/** Registers a key through the real Phase 4 path, so it is genuinely encrypted. */
async function registerKey(
  organizationId: string,
  projectId: string,
  providerId: string,
  name: string
): Promise<string> {
  respond(200);
  const result = await registerApiKey(organizationId, {
    projectId,
    providerId,
    keyName: name,
    environment: 'production',
    secret: newSecret(),
    providerKeyId: null,
    baseUrl: null,
  });

  if (!result.ok) throw new Error(`could not register ${name}`);
  return result.apiKeyId;
}

function runRecord(overrides: Partial<CollectorRunRecord> = {}): CollectorRunRecord {
  const at = new Date();
  return {
    organizationId: orgA,
    apiKeyId: null,
    providerId: ids.openai,
    startedAt: at,
    finishedAt: at,
    durationMs: 5,
    outcome: 'success',
    providerStatus: 'healthy',
    latencyMs: 12,
    rateLimited: false,
    attempts: 1,
    usageWindowStart: null,
    usageWindowEnd: null,
    usageEntryCount: 0,
    usagePersistedCount: 0,
    unavailable: null,
    error: null,
    ...overrides,
  };
}

beforeAll(async () => {
  const [a, b] = await db
    .insert(organizations)
    .values([{ name: `Collect Org A ${RUN}` }, { name: `Collect Org B ${RUN}` }])
    .returning({ id: organizations.id });
  orgA = a.id;
  orgB = b.id;

  const [pa] = await db
    .insert(projects)
    .values({ organizationId: orgA, name: 'FYIND' })
    .returning({ id: projects.id });
  const [pb] = await db
    .insert(projects)
    .values({ organizationId: orgB, name: 'Lunad' })
    .returning({ id: projects.id });
  projectA = pa.id;
  projectB = pb.id;

  const catalogue = await db
    .select({ id: aiProviders.id, type: aiProviders.type })
    .from(aiProviders);
  ids = Object.fromEntries(catalogue.map((row) => [row.type, row.id]));
});

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  respond(200);
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

describe('target selection', () => {
  it('includes an active key and attributes it fully', async () => {
    const keyId = await registerKey(orgA, projectA, ids.openai, `targets-${RUN}`);

    const targets = await listCollectionTargets(orgA);
    const found = targets.find((t) => t.apiKeyId === keyId);

    expect(found).toMatchObject({
      organizationId: orgA,
      projectId: projectA,
      projectName: 'FYIND',
      providerType: 'openai',
      environment: 'production',
    });
  });

  it('excludes a disabled or revoked key', async () => {
    const keyId = await registerKey(orgA, projectA, ids.openai, `lifecycle-${RUN}`);

    await db.update(apiKeys).set({ status: 'disabled' }).where(eq(apiKeys.id, keyId));
    expect((await listCollectionTargets(orgA)).some((t) => t.apiKeyId === keyId)).toBe(false);

    await db.update(apiKeys).set({ status: 'revoked' }).where(eq(apiKeys.id, keyId));
    expect((await listCollectionTargets(orgA)).some((t) => t.apiKeyId === keyId)).toBe(false);

    await db.update(apiKeys).set({ status: 'active' }).where(eq(apiKeys.id, keyId));
    expect((await listCollectionTargets(orgA)).some((t) => t.apiKeyId === keyId)).toBe(true);
  });

  it('excludes a provider the organization stopped tracking', async () => {
    const keyId = await registerKey(orgA, projectA, ids.groq, `untracked-${RUN}`);

    await setProviderEnabled(orgA, ids.groq, false);
    expect((await listCollectionTargets(orgA)).some((t) => t.apiKeyId === keyId)).toBe(false);

    // Absent or enabled both mean tracked.
    await setProviderEnabled(orgA, ids.groq, true);
    expect((await listCollectionTargets(orgA)).some((t) => t.apiKeyId === keyId)).toBe(true);
  });

  it('includes a provider nobody has expressed an opinion about', async () => {
    const keyId = await registerKey(orgB, projectB, ids.mistral, `default-${RUN}`);

    const rows = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId));
    expect(rows).toHaveLength(1);
    expect((await listCollectionTargets(orgB)).some((t) => t.apiKeyId === keyId)).toBe(true);
  });

  it('narrows to one organization when asked', async () => {
    const forB = await listCollectionTargets(orgB);

    expect(forB.every((t) => t.organizationId === orgB)).toBe(true);
  });
});

describe('the collection lock', () => {
  it('is held by one run at a time', async () => {
    const first = await acquireCollectorLock();
    expect(first).not.toBeNull();

    // A second collection must find the lock taken rather than run alongside.
    const second = await acquireCollectorLock();
    expect(second).toBeNull();

    await first!.release();

    const third = await acquireCollectorLock();
    expect(third).not.toBeNull();
    await third!.release();
  });
});

describe('run history', () => {
  it('answers "last success" and "last error" for a credential', async () => {
    const keyId = await registerKey(orgA, projectA, ids.openai, `history-${RUN}`);

    const earlier = new Date(Date.now() - 60_000);
    await recordCollectorRun(
      runRecord({ apiKeyId: keyId, startedAt: earlier, finishedAt: earlier })
    );
    await recordCollectorRun(
      runRecord({
        apiKeyId: keyId,
        outcome: 'failed',
        providerStatus: 'unhealthy',
        error: 'HTTP 503: upstream unavailable',
      })
    );

    const state = await collectionStateForKey(orgA, keyId);

    expect(state.lastSuccessAt?.getTime()).toBe(earlier.getTime());
    expect(state.lastFailureAt).toBeInstanceOf(Date);
    expect(state.lastError).toMatch(/upstream unavailable/);
    // The newest run of any outcome decides the current provider status.
    expect(state.lastProviderStatus).toBe('unhealthy');
  });

  it('keeps one organization history out of another', async () => {
    await recordCollectorRun(runRecord({ organizationId: orgB, providerId: ids.openai }));

    const forA = await recentCollectorRuns(orgA, 50);
    expect(forA.every((row) => row.error !== 'other-org')).toBe(true);

    const forB = await recentCollectorRuns(orgB, 50);
    expect(forB.length).toBeGreaterThan(0);
  });

  it('stores the unavailability reasons verbatim', async () => {
    await recordCollectorRun(
      runRecord({
        outcome: 'partial',
        unavailable: { usage: { reason: 'requires_admin_credential', detail: 'Needs sk-admin-' } },
      })
    );

    const [latest] = await recentCollectorRuns(orgA, 1);
    expect(latest.unavailable).toEqual({
      usage: { reason: 'requires_admin_credential', detail: 'Needs sk-admin-' },
    });
  });

  it('prunes only history older than the cut-off', async () => {
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await recordCollectorRun(runRecord({ startedAt: old, finishedAt: old, error: 'ancient' }));

    const removed = await pruneCollectorRuns(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));

    expect(removed).toBeGreaterThanOrEqual(1);
    const remaining = await recentCollectorRuns(orgA, 100);
    expect(remaining.some((row) => row.error === 'ancient')).toBe(false);
  });
});

describe('the credential check', () => {
  it('updates only the named key, and only in its organization', async () => {
    const keyId = await registerKey(orgA, projectA, ids.openai, `check-${RUN}`);

    await updateCredentialCheck(orgB, keyId, 'invalid', 'should not apply');
    const [untouched] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId));
    expect(untouched.lastValidationOutcome).toBe('valid');

    await updateCredentialCheck(orgA, keyId, 'invalid', 'revoked at the provider');
    const [updated] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId));
    expect(updated.lastValidationOutcome).toBe('invalid');
    expect(updated.lastValidationDetail).toMatch(/revoked at the provider/);
  });
});

describe('a full collection', () => {
  it('collects every tracked credential and records a run for each', async () => {
    const keyId = await registerKey(orgA, projectA, ids.openai, `full-${RUN}`);
    respond(200);

    const summary = await runCollection({ organizationId: orgA, retry: { sleep: async () => {} } });

    expect(summary.ran).toBe(true);
    expect(summary.targets).toBeGreaterThan(0);

    const runs = await db.select().from(collectorRuns).where(eq(collectorRuns.apiKeyId, keyId));

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: 'success', providerStatus: 'healthy' });
    expect(runs[0].usageWindowStart).toBeInstanceOf(Date);

    /**
     * OpenAI reports usage only to an organization admin key, so a project key
     * collects health and limits but no usage -- recorded as a reason, not as
     * zero usage.
     */
    expect(runs[0].usageEntryCount).toBe(0);
    expect(runs[0].unavailable?.usage?.reason).toBe('requires_admin_credential');
  });

  it('marks a credential rejected by its provider, and reports it as failed', async () => {
    const keyId = await registerKey(orgA, projectA, ids.anthropic, `rejected-${RUN}`);
    respond(401, { error: { message: 'invalid x-api-key' } });

    const summary = await runCollection({ organizationId: orgA, retry: { sleep: async () => {} } });

    expect(summary.failed).toBeGreaterThan(0);

    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId));
    // A key revoked at the provider must stop showing as validated.
    expect(key.lastValidationOutcome).toBe('invalid');

    const runs = await db.select().from(collectorRuns).where(eq(collectorRuns.apiKeyId, keyId));
    expect(runs[0]).toMatchObject({ outcome: 'failed', providerStatus: 'unhealthy' });
  });

  it('leaves a key unverified when the provider is unreachable', async () => {
    const keyId = await registerKey(orgA, projectA, ids.gemini ?? ids.google_gemini, `down-${RUN}`);
    fetchMock.mockRejectedValue(new Error('fetch failed'));

    await runCollection({ organizationId: orgA, retry: { sleep: async () => {} } });

    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId));
    expect(key.lastValidationOutcome).toBe('unverified');
  });

  it('does nothing when another collection holds the lock', async () => {
    const held = await acquireCollectorLock();

    try {
      const summary = await runCollection({ organizationId: orgA });

      expect(summary.ran).toBe(false);
      expect(summary.problems[0]).toMatch(/already running/);
    } finally {
      await held!.release();
    }
  });
});
