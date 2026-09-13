import { Client } from 'pg';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { acquireCollectorLock } from '@/lib/collector/lock';
import { collectDatabase } from '@/lib/databases/collect';
import { openMonitoringConnection } from '@/lib/databases/connection';
import {
  getMonitoredDatabase,
  listDatabaseTargets,
  listMonitoredDatabases,
} from '@/lib/databases/repository';
import { DATABASE_COLLECTOR_LOCK_KEY, runDatabaseCollection } from '@/lib/databases/runner';
import { loadDatabaseCredentials, registerMonitoredDatabase } from '@/lib/databases/service';
import { discardingDatabaseSink } from '@/lib/databases/sink';
import type { DatabaseCredentials } from '@/lib/databases/connection';
import type { DatabaseTarget } from '@/lib/databases/types';
import { closePool, getDb, getPool } from '@/lib/db/client';
import { getSqlState } from '@/lib/db/errors';
import { organizations, projects } from '@/lib/db/schema';
import { assessSnapshot } from '@/lib/evaluation/database';
import { HEALTH_THRESHOLDS } from '@/lib/health';

/**
 * The PostgreSQL collector against things that actually go wrong.
 *
 *   npm run db:setup && npm run test:integration
 *
 * Stubs can say what the collector does with a deadlock; only a real server can
 * say whether the collector notices one. So these cause the conditions for
 * real -- a closed port, a slow query, a genuine deadlock -- against the one
 * PostgreSQL a contributor is guaranteed to have, and check that each is seen,
 * named and judged.
 */

const RUN = Math.random().toString(36).slice(2, 10);
const db = getDb();
const url = process.env.DATABASE_URL ?? '';

let orgId: string;
let databaseId: string;
let target: DatabaseTarget;
let credentials: DatabaseCredentials;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  const [organization] = await db
    .insert(organizations)
    .values({ name: `Realworld Org ${RUN}` })
    .returning({ id: organizations.id });
  orgId = organization.id;

  const [project] = await db
    .insert(projects)
    .values({ organizationId: orgId, name: 'Platform' })
    .returning({ id: projects.id });

  const own = new URL(url);

  const registered = await registerMonitoredDatabase(orgId, {
    projectId: project.id,
    name: `Realworld ${RUN}`,
    host: own.hostname,
    port: own.port ? Number(own.port) : 5432,
    databaseName: decodeURIComponent(own.pathname.replace(/^\//, '')),
    username: decodeURIComponent(own.username),
    password: decodeURIComponent(own.password),
    sslEnabled: false,
    allowUnverifiedCertificate: false,
    environment: 'development',
  });

  if (!registered.ok) throw new Error('could not register the test database');
  databaseId = registered.databaseId;

  [target] = await listDatabaseTargets(orgId);

  const loaded = await loadDatabaseCredentials(orgId, databaseId);
  if (!loaded || 'error' in loaded) throw new Error('credentials did not load');
  credentials = loaded.credentials;
});

afterAll(async () => {
  if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  await closePool();
});

describe('an unavailable database', () => {
  it('is recorded as unreachable and named, not thrown', async () => {
    // Port 1 on loopback: nothing listens there, so the refusal is immediate.
    const snapshot = await collectDatabase(
      { ...target, host: '127.0.0.1', port: 1 },
      { credentials }
    );

    expect(snapshot.health.reachable).toBe(false);
    expect(snapshot.outcome).toBe('failed');
    expect(snapshot.error).toContain('Nothing is listening');

    const assessment = assessSnapshot(snapshot);
    expect(assessment.level).toBe('critical');
    expect(assessment.unreachable).toBe(true);
  });
});

describe('timeouts', () => {
  it('cancels a monitoring query that runs past the statement timeout', async () => {
    const opened = await openMonitoringConnection({
      host: target.host,
      port: target.port,
      databaseName: target.databaseName,
      username: target.username,
      sslEnabled: false,
      credentials,
    });

    try {
      const error = await opened.client
        .query('select pg_sleep(8)')
        .catch((caught: unknown) => caught);

      // The collector can never become the long-running query it reports on.
      expect(getSqlState(error)).toBe('57014');
    } finally {
      await opened.client.end();
    }
  });
});

describe('a long-running query', () => {
  it('is seen, and the collector does not count itself', async () => {
    const sleeper = new Client({ connectionString: url, application_name: `qa-sleeper-${RUN}` });
    await sleeper.connect();

    const seconds = HEALTH_THRESHOLDS.slowQuerySeconds + 2;
    const sleeping = sleeper.query(`select pg_sleep(${seconds})`);

    try {
      await wait((HEALTH_THRESHOLDS.slowQuerySeconds + 0.6) * 1000);

      const snapshot = await collectDatabase(target, { credentials });

      expect(snapshot.queries.slow).toMatchObject({ available: true });
      expect(snapshot.queries.slow.available && snapshot.queries.slow.value).toBeGreaterThanOrEqual(
        1
      );
      expect(
        snapshot.queries.longestRunningSeconds.available &&
          snapshot.queries.longestRunningSeconds.value
      ).toBeGreaterThanOrEqual(HEALTH_THRESHOLDS.slowQuerySeconds);
    } finally {
      await sleeping.catch(() => {});
      await sleeper.end();
    }
  }, 20_000);
});

describe('a deadlock', () => {
  it('is caused for real, counted, and judged a warning', async () => {
    const table = `qa_deadlock_${RUN}`;
    const pool = getPool();

    await pool.query(`create table ${table} (id int primary key, v int not null)`);
    await pool.query(`insert into ${table} values (1, 0), (2, 0)`);

    try {
      const before = await collectDatabase(target, { credentials });
      expect(before.counters).not.toBeNull();

      const a = new Client({ connectionString: url });
      const b = new Client({ connectionString: url });
      await a.connect();
      await b.connect();

      await a.query('begin');
      await b.query('begin');
      await a.query(`update ${table} set v = 1 where id = 1`);
      await b.query(`update ${table} set v = 1 where id = 2`);

      // Each now waits for the row the other holds. PostgreSQL breaks the cycle
      // by killing one of them after `deadlock_timeout`.
      const outcomes = await Promise.all([
        a.query(`update ${table} set v = 2 where id = 2`).catch((error: unknown) => error),
        b.query(`update ${table} set v = 2 where id = 1`).catch((error: unknown) => error),
      ]);

      const deadlock = outcomes.find((outcome) => outcome instanceof Error);
      expect(getSqlState(deadlock)).toBe('40P01');

      await a.query('rollback').catch(() => {});
      await b.query('rollback').catch(() => {});
      // Ending the sessions flushes their statistics, deadlock count included.
      await a.end();
      await b.end();

      const baseline = before.counters?.deadlocks ?? 0;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const { rows } = await pool.query<{ deadlocks: string }>(
          'select deadlocks from pg_stat_database where datname = current_database()'
        );
        if (Number(rows[0].deadlocks) > baseline) break;
        await wait(250);
      }

      const after = await collectDatabase(target, { credentials, previous: before.counters });

      expect(after.queries.deadlocksInInterval).toMatchObject({ available: true });
      expect(
        after.queries.deadlocksInInterval.available && after.queries.deadlocksInInterval.value
      ).toBeGreaterThanOrEqual(1);

      const finding = assessSnapshot(after).findings.find(
        (entry) => entry.metric === 'queries.deadlocksInInterval'
      );
      expect(finding?.level).toBe('warning');
    } finally {
      await pool.query(`drop table if exists ${table}`);
    }
  }, 20_000);
});

describe('duplicate collection prevention', () => {
  it('does nothing while another database collection holds the lock', async () => {
    const held = await acquireCollectorLock(DATABASE_COLLECTOR_LOCK_KEY);
    expect(held).not.toBeNull();

    try {
      const summary = await runDatabaseCollection({
        organizationId: orgId,
        sink: discardingDatabaseSink,
      });
      expect(summary.ran).toBe(false);
    } finally {
      await held?.release();
    }
  });

  it('is not blocked by the AI collector’s lock, which guards different work', async () => {
    const aiLock = await acquireCollectorLock();

    try {
      const summary = await runDatabaseCollection({
        organizationId: orgId,
        sink: discardingDatabaseSink,
        syncAlerts: async () => ({ raised: 0, resolved: 0 }),
        saveCheck: async () => {},
      });

      expect(summary.ran).toBe(true);
      expect(summary.targets).toBe(1);
    } finally {
      await aiLock?.release();
    }
  });
});

describe('secrets never reach a display read', () => {
  it('returns no ciphertext from any listing or detail read', async () => {
    const [listed] = await listMonitoredDatabases(orgId);
    const detail = await getMonitoredDatabase(orgId, databaseId);
    const [collectable] = await listDatabaseTargets(orgId);

    for (const view of [listed, detail, collectable]) {
      expect(view).not.toHaveProperty('encryptedCredentials');
      // The `v1.` prefix is how every stored ciphertext begins.
      expect(JSON.stringify(view)).not.toMatch(/"v1\.[A-Za-z0-9_-]+\./);
    }

    const password = decodeURIComponent(new URL(url).password);
    if (password.length >= 8) {
      expect(JSON.stringify([listed, detail, collectable])).not.toContain(password);
    }
  });
});
