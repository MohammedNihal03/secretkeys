import { describe, expect, it, vi } from 'vitest';

import { collectDatabase } from '@/lib/databases/collect';
import { runDatabaseCollection, type RunDatabaseCollectionOptions } from '@/lib/databases/runner';
import type { DatabaseMetricsSink, DatabaseSnapshot, DatabaseTarget } from '@/lib/databases/types';

/**
 * The database collection run, with every dependency replaced.
 *
 * Reliability is the subject: one database failing, crashing or disappearing
 * must never stop the others being checked, the lock must always be released,
 * and a second run must never overlap the first.
 */

function target(overrides: Partial<DatabaseTarget> = {}): DatabaseTarget {
  return {
    organizationId: 'org-1',
    organizationName: 'Acme',
    projectId: 'project-1',
    projectName: 'Platform',
    databaseId: 'db-1',
    name: 'Primary',
    host: 'db.internal',
    port: 5432,
    databaseName: 'app',
    username: 'observability',
    sslEnabled: true,
    environment: 'production',
    ...overrides,
  };
}

/** A real snapshot of an unreachable database, produced by the real collector. */
async function unreachable(of: DatabaseTarget): Promise<DatabaseSnapshot> {
  return collectDatabase(of, {
    credentials: { password: 'not-a-real-password' },
    isOwnDatabase: () => false,
    open: async () => {
      const error = Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:5432'), {
        code: 'ECONNREFUSED',
      });
      throw error;
    },
  });
}

/** The same snapshot, dressed as a successful collection. */
async function reachable(of: DatabaseTarget): Promise<DatabaseSnapshot> {
  const base = await unreachable(of);
  return {
    ...base,
    outcome: 'success',
    status: 'healthy',
    health: { ...base.health, reachable: true, error: undefined },
    error: undefined,
  };
}

const sink: DatabaseMetricsSink = {
  name: 'test',
  write: vi.fn(async () => ({ stored: 30, notes: [] })),
  previousSample: async () => null,
};

function run(overrides: Partial<RunDatabaseCollectionOptions> = {}) {
  const release = vi.fn(async () => {});

  const options: RunDatabaseCollectionOptions = {
    listTargets: async () => [target()],
    loadCredentials: async () => ({ credentials: { password: 'x' } }),
    collect: async (of) => reachable(of),
    saveCheck: async () => {},
    syncAlerts: async () => ({ raised: 0, resolved: 0 }),
    acquireLock: async () => ({ release }),
    sink,
    ...overrides,
  };

  return { release, summary: runDatabaseCollection(options) };
}

describe('the database collection run', () => {
  it('does nothing while another run holds the lock', async () => {
    const collect = vi.fn();
    const { summary } = run({ acquireLock: async () => null, collect });

    const result = await summary;

    // Two runs at once would open two monitoring connections per database.
    expect(result.ran).toBe(false);
    expect(collect).not.toHaveBeenCalled();
    expect(result.problems[0]).toMatch(/already running/);
  });

  it('releases the lock even when listing targets throws', async () => {
    const { summary, release } = run({
      listTargets: async () => {
        throw new Error('dashboard database went away');
      },
    });

    await expect(summary).rejects.toThrow('went away');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps checking the others when one database is down', async () => {
    const targets = [
      target({ databaseId: 'a', name: 'A' }),
      target({ databaseId: 'b', name: 'B' }),
    ];
    const { summary } = run({
      listTargets: async () => targets,
      collect: async (of) => (of.databaseId === 'a' ? unreachable(of) : reachable(of)),
    });

    const result = await summary;

    expect(result.targets).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.success).toBe(1);
    // The failure is named, and names what to do.
    expect(result.problems.some((problem) => problem.includes('Nothing is listening'))).toBe(true);
  });

  it('contains a crash to the database it happened on', async () => {
    const targets = [
      target({ databaseId: 'a', name: 'A' }),
      target({ databaseId: 'b', name: 'B' }),
    ];
    const saved: string[] = [];

    const { summary, release } = run({
      listTargets: async () => targets,
      collect: async (of) => {
        if (of.databaseId === 'a') throw new Error('unexpected collector defect');
        return reachable(of);
      },
      saveCheck: async (snapshot) => {
        saved.push(snapshot.target.databaseId);
      },
    });

    const result = await summary;

    expect(result.failed).toBe(1);
    expect(saved).toEqual(['b']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('scrubs the role name out of a crash message', async () => {
    const { summary } = run({
      collect: async () => {
        throw new Error('role observability failed at postgresql://observability:hunter2@db/app');
      },
    });

    const result = await summary;
    const text = result.problems.join(' ');

    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('observability');
  });

  it('records a credential that will not decrypt as a failure, and moves on', async () => {
    const targets = [target({ databaseId: 'a' }), target({ databaseId: 'b' })];
    const { summary } = run({
      listTargets: async () => targets,
      loadCredentials: async (of) =>
        of.databaseId === 'a'
          ? { error: 'Encrypted with a key that is not configured.' }
          : { credentials: { password: 'x' } },
    });

    const result = await summary;

    expect(result.failed).toBe(1);
    expect(result.success).toBe(1);
    expect(result.problems.some((problem) => problem.includes('not configured'))).toBe(true);
  });

  it('skips a database deleted between listing and collecting', async () => {
    const { summary } = run({ loadCredentials: async () => null });

    const result = await summary;

    expect(result.skipped).toBe(1);
    expect(result.targets).toBe(0);
  });

  it('adds up what the sink stored and what alerts changed', async () => {
    const targets = [target({ databaseId: 'a' }), target({ databaseId: 'b' })];
    const { summary } = run({
      listTargets: async () => targets,
      syncAlerts: async (snapshot) =>
        snapshot.target.databaseId === 'a'
          ? { raised: 2, resolved: 0 }
          : { raised: 0, resolved: 1 },
    });

    const result = await summary;

    expect(result.metricsStored).toBe(60);
    expect(result.alertsRaised).toBe(2);
    expect(result.alertsResolved).toBe(1);
  });

  it('never runs one database twice at the same time', async () => {
    let inFlight = 0;
    let peak = 0;
    const targets = Array.from({ length: 6 }, (_unused, index) =>
      target({ databaseId: `db-${index}` })
    );

    const { summary } = run({
      listTargets: async () => targets,
      collect: async (of) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return reachable(of);
      },
      concurrency: 2,
    });

    const result = await summary;

    // Bounded, so a struggling fleet is not hit by every connection at once.
    expect(peak).toBeLessThanOrEqual(2);
    expect(result.success).toBe(6);
  });
});
