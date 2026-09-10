import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveMembership, resolveMemberships } from '@/lib/auth/access';
import { hashPassword } from '@/lib/auth/password';
import { hasPermission } from '@/lib/auth/permissions';
import {
  SESSION_IDLE_TIMEOUT_MS,
  createSession,
  hashSessionToken,
  revokeAllUserSessions,
  revokeSessionByToken,
  validateSessionToken,
} from '@/lib/auth/session';
import { closePool, getDb } from '@/lib/db/client';
import { organizationMembers, organizations, sessions, users } from '@/lib/db/schema';

/**
 * Authentication and organization isolation, against a real database.
 *
 *   npm run db:migrate && npm run test:integration
 *
 * The central requirement being verified is the one the build plan calls out:
 * organization A must not be able to reach organization B's resources. Here
 * that is exercised through the real membership lookup rather than asserted
 * about the schema.
 */

const RUN = Math.random().toString(36).slice(2, 10);
const db = getDb();

let orgA: string;
let orgB: string;
/** Admin of org A only. */
let alice: string;
/** Developer in org B only. */
let bob: string;
/** Member of both, with a different role in each. */
let carol: string;
/** Signed up, but belongs to no organization. */
let dave: string;

let sharedHash: string;

async function createUser(email: string, name: string): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email, name, passwordHash: sharedHash })
    .returning({ id: users.id });

  return row.id;
}

beforeAll(async () => {
  // One derivation shared by every fixture: scrypt is deliberately slow.
  sharedHash = await hashPassword('fixture-password-1234');

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

  alice = await createUser(`alice-${RUN}@example.com`, 'Alice');
  bob = await createUser(`bob-${RUN}@example.com`, 'Bob');
  carol = await createUser(`carol-${RUN}@example.com`, 'Carol');
  dave = await createUser(`dave-${RUN}@example.com`, 'Dave');

  await db.insert(organizationMembers).values([
    { organizationId: orgA, userId: alice, role: 'org_admin' },
    { organizationId: orgB, userId: bob, role: 'developer' },
    { organizationId: orgA, userId: carol, role: 'developer' },
    { organizationId: orgB, userId: carol, role: 'org_admin' },
  ]);
}, 60_000);

afterAll(async () => {
  for (const id of [alice, bob, carol, dave].filter(Boolean)) {
    await db.delete(users).where(eq(users.id, id));
  }
  for (const id of [orgA, orgB].filter(Boolean)) {
    await db.delete(organizations).where(eq(organizations.id, id));
  }
  await closePool();
});

describe('organization isolation', () => {
  it('grants a member access to their own organization', async () => {
    const membership = await resolveMembership(alice, orgA);

    expect(membership?.role).toBe('org_admin');
    expect(membership?.organizationId).toBe(orgA);
  });

  it('denies a member access to a different organization', async () => {
    // Alice administers org A. That must convey nothing at all about org B.
    expect(await resolveMembership(alice, orgB)).toBeNull();
    expect(await resolveMembership(bob, orgA)).toBeNull();
  });

  it('denies a user who belongs to no organization', async () => {
    // A valid account is not authority over anything.
    expect(await resolveMembership(dave, orgA)).toBeNull();
    expect(await resolveMembership(dave, orgB)).toBeNull();
    expect(await resolveMemberships(dave)).toEqual([]);
  });

  it('is indistinguishable from a non-existent organization', async () => {
    // Both null, so a caller cannot probe for other tenants by id.
    const missing = '00000000-0000-0000-0000-000000000000';

    expect(await resolveMembership(alice, missing)).toBeNull();
    expect(await resolveMembership(alice, orgB)).toBeNull();
  });

  it('keeps a per-organization role for a user in several organizations', async () => {
    // Carol reads in A but administers B. A single global role would be wrong.
    const inA = await resolveMembership(carol, orgA);
    const inB = await resolveMembership(carol, orgB);

    expect(inA?.role).toBe('developer');
    expect(inB?.role).toBe('org_admin');

    expect(hasPermission(inA!.role, 'api_keys:manage')).toBe(false);
    expect(hasPermission(inB!.role, 'api_keys:manage')).toBe(true);
  });

  it('lists only the organizations a user belongs to', async () => {
    expect((await resolveMemberships(alice)).map((m) => m.organizationId)).toEqual([orgA]);
    expect((await resolveMemberships(carol)).map((m) => m.organizationId).sort()).toEqual(
      [orgA, orgB].sort()
    );
  });

  it('revokes access when the membership row is deleted', async () => {
    const [org] = await db
      .insert(organizations)
      .values({ name: `Org Temp ${RUN}` })
      .returning({ id: organizations.id });

    await db.insert(organizationMembers).values({
      organizationId: org.id,
      userId: dave,
      role: 'developer',
    });

    expect(await resolveMembership(dave, org.id)).not.toBeNull();

    await db.delete(organizationMembers).where(eq(organizationMembers.organizationId, org.id));

    expect(await resolveMembership(dave, org.id)).toBeNull();

    await db.delete(organizations).where(eq(organizations.id, org.id));
  });
});

describe('session lifecycle', () => {
  it('issues a token that resolves to its user', async () => {
    const { token } = await createSession(alice);
    const resolved = await validateSessionToken(token);

    expect(resolved?.user.id).toBe(alice);
    expect(resolved?.user.email).toBe(`alice-${RUN}@example.com`);

    await revokeSessionByToken(token);
  });

  it('never stores the token itself', async () => {
    const { token } = await createSession(alice);

    const [stored] = await db
      .select({ tokenHash: sessions.tokenHash })
      .from(sessions)
      .where(eq(sessions.tokenHash, hashSessionToken(token)));

    // A dump of this table must not be replayable.
    expect(stored.tokenHash).not.toBe(token);
    expect(stored.tokenHash).toBe(hashSessionToken(token));

    await revokeSessionByToken(token);
  });

  it('omits the password hash from the resolved user', async () => {
    const { token } = await createSession(alice);
    const resolved = await validateSessionToken(token);

    expect(resolved?.user).not.toHaveProperty('passwordHash');

    await revokeSessionByToken(token);
  });

  it('rejects an unknown token', async () => {
    expect(await validateSessionToken('not-a-real-token')).toBeNull();
  });

  it('rejects an empty token without querying', async () => {
    expect(await validateSessionToken('')).toBeNull();
  });

  it('rejects a revoked session immediately', async () => {
    const { token } = await createSession(alice);
    await revokeSessionByToken(token);

    // Server-side sessions exist precisely so sign-out is instant.
    expect(await validateSessionToken(token)).toBeNull();
  });

  it('revokes every session for a user at once', async () => {
    const first = await createSession(bob);
    const second = await createSession(bob);

    await revokeAllUserSessions(bob);

    expect(await validateSessionToken(first.token)).toBeNull();
    expect(await validateSessionToken(second.token)).toBeNull();
  });

  it('rejects an expired session and deletes it', async () => {
    const { token } = await createSession(alice);
    const tokenHash = hashSessionToken(token);

    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.tokenHash, tokenHash));

    expect(await validateSessionToken(token)).toBeNull();

    // Cleaned up on access, so abandoned rows do not accumulate.
    expect(await db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash))).toHaveLength(
      0
    );
  });

  it('rejects a session idle beyond the timeout, even if not yet expired', async () => {
    const { token } = await createSession(alice);

    await db
      .update(sessions)
      .set({ lastUsedAt: new Date(Date.now() - SESSION_IDLE_TIMEOUT_MS - 60_000) })
      .where(eq(sessions.tokenHash, hashSessionToken(token)));

    expect(await validateSessionToken(token)).toBeNull();
  });

  it('rejects a session whose user has been disabled', async () => {
    const { token } = await createSession(dave);

    expect(await validateSessionToken(token)).not.toBeNull();

    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, dave));

    // Must take effect on the next request, not at token expiry.
    expect(await validateSessionToken(token)).toBeNull();

    await db.update(users).set({ status: 'active' }).where(eq(users.id, dave));
    await revokeSessionByToken(token);
  });

  it('cascades session deletion when the user is deleted', async () => {
    const victim = await createUser(`victim-${RUN}@example.com`, 'Victim');
    const { token } = await createSession(victim);

    await db.delete(users).where(eq(users.id, victim));

    expect(await validateSessionToken(token)).toBeNull();
    expect(
      await db
        .select()
        .from(sessions)
        .where(eq(sessions.tokenHash, hashSessionToken(token)))
    ).toHaveLength(0);
  });
});
