import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePool, getDb } from '@/lib/db/client';
import { PG_ERROR, getSqlState } from '@/lib/db/errors';
import { aiProviders, apiKeys, monitoredDatabases, organizations, projects } from '@/lib/db/schema';

/**
 * Integration tests against a real PostgreSQL instance with migrations applied.
 *
 *   npm run db:migrate && npm run test:integration
 *
 * These verify the constraints that unit tests can only assert are *declared*.
 * The important ones are the composite foreign keys: if organization isolation
 * is enforced only by careful queries, a single missing WHERE clause leaks data
 * between tenants. Here it is the database that refuses.
 */

/** Suffix so repeated runs, and a failed run's leftovers, cannot collide. */
const RUN = Math.random().toString(36).slice(2, 10);

const db = getDb();

let orgA: string;
let orgB: string;
let projectA: string;
let projectB: string;
let openaiProviderId: string;

/**
 * Asserts the database rejected a statement with a specific SQLSTATE.
 *
 * The rejection is captured as a value rather than in a try/catch, so a failed
 * assertion is not mistaken for the database error being asserted on.
 */
async function expectSqlState(operation: Promise<unknown>, expected: string): Promise<void> {
  const rejection = await operation.then(
    () => null,
    (error: unknown) => ({ error })
  );

  expect(rejection, 'expected the database to reject this statement').not.toBeNull();
  expect(getSqlState(rejection!.error), `expected SQLSTATE ${expected}`).toBe(expected);
}

function newKey(overrides: Partial<typeof apiKeys.$inferInsert>): typeof apiKeys.$inferInsert {
  return {
    organizationId: orgA,
    projectId: projectA,
    providerId: openaiProviderId,
    keyName: `key-${RUN}`,
    encryptedKey: 'ciphertext-placeholder',
    keyLast4: 'A91F',
    environment: 'production',
    ...overrides,
  };
}

beforeAll(async () => {
  const [a] = await db
    .insert(organizations)
    .values({ name: `Org A ${RUN}` })
    .returning({ id: organizations.id });
  const [b] = await db
    .insert(organizations)
    .values({ name: `Org B ${RUN}` })
    .returning({ id: organizations.id });

  orgA = a.id;
  orgB = b.id;

  const [pa] = await db
    .insert(projects)
    .values({ organizationId: orgA, name: 'FYIND', environment: 'production' })
    .returning({ id: projects.id });
  const [pb] = await db
    .insert(projects)
    .values({ organizationId: orgB, name: 'Lunad', environment: 'production' })
    .returning({ id: projects.id });

  projectA = pa.id;
  projectB = pb.id;

  const provider = await db.query.aiProviders.findFirst({
    where: eq(aiProviders.type, 'openai'),
  });

  expect(provider, 'the provider catalogue must be seeded by migration 0001').toBeDefined();
  openaiProviderId = provider!.id;
});

afterAll(async () => {
  // Cascades remove every project, key and database created below.
  for (const id of [orgA, orgB].filter(Boolean)) {
    await db.delete(organizations).where(eq(organizations.id, id));
  }
  await closePool();
});

describe('provider catalogue', () => {
  it('is seeded with the three MVP adapters', async () => {
    const rows = await db.select({ type: aiProviders.type }).from(aiProviders);
    const types = rows.map((row) => row.type);

    expect(types).toEqual(expect.arrayContaining(['openai', 'google_gemini', 'anthropic']));
  });
});

describe('organization isolation', () => {
  it('refuses an API key pairing one organization with another organization project', async () => {
    // The single-column foreign keys are both satisfied here: orgB exists and
    // projectA exists. Only the composite key catches the mismatch.
    await expectSqlState(
      db.insert(apiKeys).values(newKey({ organizationId: orgB, projectId: projectA })),
      PG_ERROR.foreignKeyViolation
    );
  });

  it('refuses a monitored database pairing mismatched organization and project', async () => {
    await expectSqlState(
      db.insert(monitoredDatabases).values({
        organizationId: orgA,
        projectId: projectB,
        name: `db-${RUN}`,
        host: 'db.internal',
        databaseName: 'app',
        username: 'observer',
        encryptedCredentials: 'ciphertext-placeholder',
        environment: 'production',
      }),
      PG_ERROR.foreignKeyViolation
    );
  });

  it('accepts a correctly paired organization and project', async () => {
    const [row] = await db
      .insert(apiKeys)
      .values(newKey({ keyName: `paired-${RUN}` }))
      .returning({ id: apiKeys.id, organizationId: apiKeys.organizationId });

    expect(row.organizationId).toBe(orgA);
    await db.delete(apiKeys).where(eq(apiKeys.id, row.id));
  });

  it('lets two organizations use the same project name', async () => {
    // Names are unique per organization, not globally.
    const [row] = await db
      .insert(projects)
      .values({ organizationId: orgB, name: 'FYIND' })
      .returning({ id: projects.id });

    expect(row.id).toBeTruthy();
    await db.delete(projects).where(eq(projects.id, row.id));
  });
});

describe('duplicate protection', () => {
  it('rejects a second key with the same name in one organization', async () => {
    const [first] = await db
      .insert(apiKeys)
      .values(newKey({ keyName: `dup-name-${RUN}` }))
      .returning({ id: apiKeys.id });

    await expectSqlState(
      db.insert(apiKeys).values(newKey({ keyName: `dup-name-${RUN}` })),
      PG_ERROR.uniqueViolation
    );

    await db.delete(apiKeys).where(eq(apiKeys.id, first.id));
  });

  it('rejects the same secret registered twice, by fingerprint', async () => {
    // Two projects crediting the same physical key would each be billed the
    // full usage, making per-project cost silently wrong.
    const fingerprint = `fp-${RUN}`;

    const [first] = await db
      .insert(apiKeys)
      .values(newKey({ keyName: `fp-a-${RUN}`, keyFingerprint: fingerprint }))
      .returning({ id: apiKeys.id });

    await expectSqlState(
      db.insert(apiKeys).values(newKey({ keyName: `fp-b-${RUN}`, keyFingerprint: fingerprint })),
      PG_ERROR.uniqueViolation
    );

    await db.delete(apiKeys).where(eq(apiKeys.id, first.id));
  });

  it('still allows many keys with no fingerprint yet', async () => {
    // NULLs are distinct in a Postgres unique constraint, so pre-Phase-4 rows
    // coexist while real fingerprints stay unique.
    const rows = await db
      .insert(apiKeys)
      .values([newKey({ keyName: `null-fp-a-${RUN}` }), newKey({ keyName: `null-fp-b-${RUN}` })])
      .returning({ id: apiKeys.id });

    expect(rows).toHaveLength(2);
    for (const row of rows) await db.delete(apiKeys).where(eq(apiKeys.id, row.id));
  });
});

describe('referential lifecycle', () => {
  it('cascades an organization deletion through projects and keys', async () => {
    const [org] = await db
      .insert(organizations)
      .values({ name: `Org Cascade ${RUN}` })
      .returning({ id: organizations.id });
    const [project] = await db
      .insert(projects)
      .values({ organizationId: org.id, name: 'Doomed' })
      .returning({ id: projects.id });
    const [key] = await db
      .insert(apiKeys)
      .values(
        newKey({
          organizationId: org.id,
          projectId: project.id,
          keyName: `cascade-${RUN}`,
        })
      )
      .returning({ id: apiKeys.id });

    await db.delete(organizations).where(eq(organizations.id, org.id));

    expect(await db.select().from(projects).where(eq(projects.id, project.id))).toHaveLength(0);
    expect(await db.select().from(apiKeys).where(eq(apiKeys.id, key.id))).toHaveLength(0);
  });

  it('refuses to delete a provider that credentials still reference', async () => {
    // Removing an adapter from the catalogue must not destroy tenant
    // credentials or the usage history pointing at them.
    const [key] = await db
      .insert(apiKeys)
      .values(newKey({ keyName: `provider-guard-${RUN}` }))
      .returning({ id: apiKeys.id });

    await expectSqlState(
      db.delete(aiProviders).where(eq(aiProviders.id, openaiProviderId)),
      // ON DELETE RESTRICT raises restrict_violation, not foreign_key_violation.
      PG_ERROR.restrictViolation
    );

    await db.delete(apiKeys).where(eq(apiKeys.id, key.id));
  });
});

describe('timestamps', () => {
  it('sets created_at and updated_at on insert', async () => {
    const [row] = await db
      .insert(projects)
      .values({ organizationId: orgA, name: `Stamped ${RUN}` })
      .returning({
        id: projects.id,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
      });

    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);

    await db.delete(projects).where(eq(projects.id, row.id));
  });

  it('advances updated_at on update but leaves created_at alone', async () => {
    const [row] = await db
      .insert(projects)
      .values({ organizationId: orgA, name: `Touched ${RUN}` })
      .returning({
        id: projects.id,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
      });

    /**
     * A short wait so the update lands in a later millisecond than the insert.
     * `now()` is the transaction timestamp and JS `Date` has millisecond
     * resolution, so without it two statements can share a timestamp and the
     * assertion below would be untestable either way.
     */
    await new Promise((resolve) => setTimeout(resolve, 10));

    const [updated] = await db
      .update(projects)
      .set({ description: 'changed' })
      .where(eq(projects.id, row.id))
      .returning({ createdAt: projects.createdAt, updatedAt: projects.updatedAt });

    expect(updated.createdAt.getTime()).toBe(row.createdAt.getTime());

    /**
     * Both timestamps now come from the database clock via the
     * `set_updated_at` trigger, so this ordering holds absolutely. It did not
     * when `updated_at` was set from the application clock: the two could
     * disagree, and `updated_at` was observed landing 1ms before
     * `created_at`.
     */
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(updated.createdAt.getTime());
    expect(updated.updatedAt.getTime()).toBeGreaterThan(row.updatedAt.getTime());

    await db.delete(projects).where(eq(projects.id, row.id));
  });
});
