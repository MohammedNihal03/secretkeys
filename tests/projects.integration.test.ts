import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePool, getDb } from '@/lib/db/client';
import { aiProviders, apiKeys, organizations } from '@/lib/db/schema';
import {
  createProject,
  getProject,
  listProjects,
  projectDependencies,
  updateProject,
} from '@/lib/projects/repository';
import { catalogueEntries } from '@/lib/providers/registry';

/**
 * Project repository, against a real database.
 *
 *   npm run db:setup && npm run test:integration
 *
 * The point of these is the tenant boundary: every repository function takes an
 * organization id and must be unable to reach another organization's rows, even
 * when handed a valid project id from elsewhere.
 */

const RUN = Math.random().toString(36).slice(2, 10);
const db = getDb();

let orgA: string;
let orgB: string;

beforeAll(async () => {
  const [a] = await db
    .insert(organizations)
    .values({ name: `Proj Org A ${RUN}` })
    .returning({ id: organizations.id });
  const [b] = await db
    .insert(organizations)
    .values({ name: `Proj Org B ${RUN}` })
    .returning({ id: organizations.id });

  orgA = a.id;
  orgB = b.id;
});

afterAll(async () => {
  for (const id of [orgA, orgB].filter(Boolean)) {
    await db.delete(organizations).where(eq(organizations.id, id));
  }
  await closePool();
});

describe('create', () => {
  it('creates a project scoped to its organization', async () => {
    const result = await createProject(orgA, {
      name: `Create ${RUN}`,
      description: 'desc',
      environment: 'production',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.organizationId).toBe(orgA);
      expect(result.project.environment).toBe('production');
    }
  });

  it('rejects a duplicate name within the same organization', async () => {
    await createProject(orgA, { name: `Dup ${RUN}`, description: null, environment: 'production' });

    const second = await createProject(orgA, {
      name: `Dup ${RUN}`,
      description: null,
      environment: 'staging',
    });

    // Surfaced as a result rather than an exception, so a form can show it.
    expect(second).toEqual({ ok: false, error: 'duplicate_name' });
  });

  it('allows the same name in a different organization', async () => {
    const name = `Shared ${RUN}`;

    expect(
      (await createProject(orgA, { name, description: null, environment: 'production' })).ok
    ).toBe(true);
    expect(
      (await createProject(orgB, { name, description: null, environment: 'production' })).ok
    ).toBe(true);
  });
});

describe('read', () => {
  it('lists only the requesting organization projects', async () => {
    await createProject(orgA, {
      name: `ListA ${RUN}`,
      description: null,
      environment: 'production',
    });
    await createProject(orgB, {
      name: `ListB ${RUN}`,
      description: null,
      environment: 'production',
    });

    const namesA = (await listProjects(orgA)).map((p) => p.name);
    const namesB = (await listProjects(orgB)).map((p) => p.name);

    expect(namesA).toContain(`ListA ${RUN}`);
    expect(namesA).not.toContain(`ListB ${RUN}`);
    expect(namesB).toContain(`ListB ${RUN}`);
    expect(namesB).not.toContain(`ListA ${RUN}`);
  });

  it('returns projects in name order', async () => {
    const names = (await listProjects(orgA)).map((p) => p.name);

    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('refuses to read a project belonging to another organization', async () => {
    const created = await createProject(orgB, {
      name: `Secret ${RUN}`,
      description: null,
      environment: 'production',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // A valid id, but org A must not be able to read it.
    expect(await getProject(orgA, created.project.id)).toBeNull();
    expect(await getProject(orgB, created.project.id)).not.toBeNull();
  });

  it('returns null for an id that does not exist', async () => {
    expect(await getProject(orgA, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('update', () => {
  it('updates a project in the same organization', async () => {
    const created = await createProject(orgA, {
      name: `Update ${RUN}`,
      description: null,
      environment: 'development',
    });
    if (!created.ok) throw new Error('setup failed');

    const result = await updateProject(orgA, created.project.id, {
      name: `Updated ${RUN}`,
      description: 'now described',
      environment: 'staging',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.name).toBe(`Updated ${RUN}`);
      expect(result.project.environment).toBe('staging');
      expect(result.project.description).toBe('now described');
    }
  });

  it('refuses to update another organization project', async () => {
    const created = await createProject(orgB, {
      name: `Victim ${RUN}`,
      description: null,
      environment: 'production',
    });
    if (!created.ok) throw new Error('setup failed');

    const result = await updateProject(orgA, created.project.id, {
      name: 'hijacked',
      description: null,
      environment: 'production',
    });

    // Reported as not found, not forbidden: org A must learn nothing about it.
    expect(result).toEqual({ ok: false, error: 'not_found' });

    // And the row is untouched.
    const untouched = await getProject(orgB, created.project.id);
    expect(untouched?.name).toBe(`Victim ${RUN}`);
  });

  it('reports a duplicate name on update', async () => {
    const first = await createProject(orgA, {
      name: `Taken ${RUN}`,
      description: null,
      environment: 'production',
    });
    const second = await createProject(orgA, {
      name: `Renaming ${RUN}`,
      description: null,
      environment: 'production',
    });
    if (!first.ok || !second.ok) throw new Error('setup failed');

    const result = await updateProject(orgA, second.project.id, {
      name: `Taken ${RUN}`,
      description: null,
      environment: 'production',
    });

    expect(result).toEqual({ ok: false, error: 'duplicate_name' });
  });

  it('advances updated_at', async () => {
    const created = await createProject(orgA, {
      name: `Touch ${RUN}`,
      description: null,
      environment: 'production',
    });
    if (!created.ok) throw new Error('setup failed');

    const result = await updateProject(orgA, created.project.id, {
      name: `Touch ${RUN}`,
      description: 'changed',
      environment: 'production',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.updatedAt.getTime()).toBeGreaterThanOrEqual(
        created.project.createdAt.getTime()
      );
    }
  });
});

describe('dependency counts', () => {
  it('counts API keys registered against a project', async () => {
    const created = await createProject(orgA, {
      name: `Counted ${RUN}`,
      description: null,
      environment: 'production',
    });
    if (!created.ok) throw new Error('setup failed');

    const [provider] = await db
      .select({ id: aiProviders.id })
      .from(aiProviders)
      .where(eq(aiProviders.type, 'openai'));

    await db.insert(apiKeys).values([
      {
        organizationId: orgA,
        projectId: created.project.id,
        providerId: provider.id,
        keyName: `count-a-${RUN}`,
        encryptedKey: 'ciphertext',
        keyLast4: 'AAAA',
        environment: 'production',
      },
      {
        organizationId: orgA,
        projectId: created.project.id,
        providerId: provider.id,
        keyName: `count-b-${RUN}`,
        encryptedKey: 'ciphertext',
        keyLast4: 'BBBB',
        environment: 'staging',
      },
    ]);

    const project = await getProject(orgA, created.project.id);
    expect(project?.apiKeyCount).toBe(2);
    // Counted independently, so keys must not inflate the database count.
    expect(project?.databaseCount).toBe(0);

    expect(await projectDependencies(orgA, created.project.id)).toEqual({
      apiKeyCount: 2,
      databaseCount: 0,
    });
  });

  it('reports no dependencies for a project in another organization', async () => {
    const created = await createProject(orgB, {
      name: `Hidden ${RUN}`,
      description: null,
      environment: 'production',
    });
    if (!created.ok) throw new Error('setup failed');

    expect(await projectDependencies(orgA, created.project.id)).toBeNull();
  });
});

describe('provider catalogue', () => {
  it('holds exactly the providers the adapter registry declares', async () => {
    const rows = await db.select({ type: aiProviders.type }).from(aiProviders);
    const inDatabase = rows.map((row) => row.type).sort();
    const inCode = catalogueEntries()
      .map((entry) => entry.type)
      .sort();

    // Seeded from the registry, so drift here means db:seed was not run.
    expect(inDatabase).toEqual(inCode);
  });
});
