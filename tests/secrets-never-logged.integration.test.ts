import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCollection } from '@/lib/collector/runner';
import { discardingUsageSink } from '@/lib/collector/sink';
import { registerApiKey } from '@/lib/credentials/service';
import { registerMonitoredDatabase } from '@/lib/databases/service';
import { closePool, getDb } from '@/lib/db/client';
import { aiProviders, collectorRuns, organizations, projects } from '@/lib/db/schema';

/**
 * Secrets never reach a log.
 *
 * Every path here is one where a secret is most likely to escape: a provider
 * that echoes the key back in an error body, a network failure whose message
 * quotes the request, a database that refuses a password. All console output
 * and all collector log lines are captured, and the secret must not appear in
 * any of them -- nor in anything returned to a caller or written to a run.
 */

const RUN = Math.random().toString(36).slice(2, 10);
const db = getDb();

/** Distinctive, so a partial echo is still found. */
const SECRET = `sk-proj-LEAKCANARY${RUN}${'Q'.repeat(28)}`;

let orgId: string;
let projectId: string;
let openaiId: string;

const captured: string[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

function capture(...args: unknown[]) {
  captured.push(
    args
      .map((arg) =>
        arg instanceof Error
          ? `${arg.message} ${arg.stack}`
          : typeof arg === 'string'
            ? arg
            : JSON.stringify(arg)
      )
      .join(' ')
  );
}

function assertNoLeak(label: string) {
  const everything = captured.join('\n');
  expect(everything, `${label}: secret appeared in captured output`).not.toContain(SECRET);
  // A provider that truncates still leaks the distinctive middle of the key.
  expect(everything, `${label}: partial secret appeared`).not.toContain(`LEAKCANARY${RUN}`);
}

beforeAll(async () => {
  const [organization] = await db
    .insert(organizations)
    .values({ name: `Leak Org ${RUN}` })
    .returning({ id: organizations.id });
  orgId = organization.id;

  const [project] = await db
    .insert(projects)
    .values({ organizationId: orgId, name: 'Platform' })
    .returning({ id: projects.id });
  projectId = project.id;

  const [openai] = await db
    .select({ id: aiProviders.id })
    .from(aiProviders)
    .where(eq(aiProviders.type, 'openai'));
  openaiId = openai.id;
});

beforeEach(() => {
  captured.length = 0;
  for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation(capture);
  }
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  await closePool();
});

describe('secrets never reach a log', () => {
  it('when a provider rejects the key and echoes it back', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ error: { message: `Incorrect API key provided: ${SECRET}` } }),
          { status: 401 }
        )
    );

    const result = await registerApiKey(orgId, {
      projectId,
      providerId: openaiId,
      keyName: `Rejected ${RUN}`,
      environment: 'production',
      secret: SECRET,
      providerKeyId: null,
      baseUrl: null,
    });

    capture(JSON.stringify(result));
    expect(result.ok).toBe(false);
    assertNoLeak('rejected registration');
  });

  it('when the network fails with a message quoting the request', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError(`fetch failed for Authorization: Bearer ${SECRET}`);
    });

    const result = await registerApiKey(orgId, {
      projectId,
      providerId: openaiId,
      keyName: `Unreachable ${RUN}`,
      environment: 'production',
      secret: SECRET,
      providerKeyId: null,
      baseUrl: null,
    });

    capture(JSON.stringify(result));
    assertNoLeak('network failure during registration');
  });

  it('when a collection fails against a provider that echoes the key', async () => {
    // Register successfully first, so there is something to collect from.
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 })
    );

    const registered = await registerApiKey(orgId, {
      projectId,
      providerId: openaiId,
      keyName: `Collected ${RUN}`,
      environment: 'production',
      secret: `${SECRET}B`,
      providerKeyId: null,
      baseUrl: null,
    });
    expect(registered.ok).toBe(true);

    fetchMock.mockImplementation(
      async () => new Response(`upstream exploded while handling key ${SECRET}B`, { status: 500 })
    );

    const summary = await runCollection({
      organizationId: orgId,
      retry: { sleep: async () => {} },
      sink: discardingUsageSink,
      syncAlerts: async () => ({ raised: 0, resolved: 0 }),
      logger: capture,
    });

    capture(JSON.stringify(summary));

    const runs = await db
      .select({ error: collectorRuns.error, unavailable: collectorRuns.unavailable })
      .from(collectorRuns)
      .where(eq(collectorRuns.organizationId, orgId));
    capture(JSON.stringify(runs));

    assertNoLeak('failed collection');
  });

  it('when a database refuses the password', async () => {
    const own = new URL(process.env.DATABASE_URL ?? '');
    const password = `LEAKCANARY${RUN}-db-password`;

    const result = await registerMonitoredDatabase(orgId, {
      projectId,
      name: `Refused ${RUN}`,
      host: own.hostname,
      port: own.port ? Number(own.port) : 5432,
      databaseName: decodeURIComponent(own.pathname.replace(/^\//, '')),
      username: decodeURIComponent(own.username),
      password,
      sslEnabled: false,
      allowUnverifiedCertificate: false,
      environment: 'development',
    });

    capture(JSON.stringify(result));
    expect(result.ok).toBe(false);
    expect(captured.join('\n')).not.toContain(password);
  });
});
