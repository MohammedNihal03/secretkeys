import { randomBytes } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { eq } from 'drizzle-orm';

import { MIN_PASSWORD_LENGTH, hashPassword, normalizeEmail } from '@/lib/auth/password';
import { closePool, getDb } from '@/lib/db/client';
import { organizationMembers, organizations, users } from '@/lib/db/schema';

/**
 * Static imports are safe here even though they are hoisted above this call:
 * `env.ts` parses lazily on first `getEnv()`, which does not happen until a
 * pool is actually opened.
 */
loadDotenv({ path: '.env.local', quiet: true });
loadDotenv({ path: '.env', quiet: true });

/**
 * Creates the first organization and its administrator.
 *
 * A CLI script rather than a first-run web page on purpose: an unauthenticated
 * setup endpoint is a permanent liability if it is ever reachable after setup,
 * and getting that lifecycle right is more work than running one command.
 *
 *   ORG_NAME="Acme" ADMIN_EMAIL="you@acme.com" ADMIN_NAME="You" npm run bootstrap
 *
 * Configuration comes from the environment rather than argv, because argv is
 * visible to other users via the process list. If ADMIN_PASSWORD is omitted a
 * strong one is generated and printed once.
 */

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    console.error(`Missing ${name}.

Usage:
  ORG_NAME="Acme" ADMIN_EMAIL="you@acme.com" ADMIN_NAME="Your Name" npm run bootstrap

ADMIN_PASSWORD is optional -- one is generated if you omit it.`);
    process.exit(1);
  }

  return value;
}

/** 24 bytes of base64url: ~144 bits, comfortably beyond guessing. */
function generatePassword(): string {
  return randomBytes(24).toString('base64url');
}

async function main(): Promise<void> {
  const orgName = requireEnv('ORG_NAME');
  const adminName = requireEnv('ADMIN_NAME');
  const email = normalizeEmail(requireEnv('ADMIN_EMAIL'));

  const provided = process.env.ADMIN_PASSWORD?.trim();
  const generated = !provided;
  const password = provided ?? generatePassword();

  if (provided && provided.length < MIN_PASSWORD_LENGTH) {
    console.error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exit(1);
  }

  const db = getDb();

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));

  if (existing) {
    console.error(`A user with that email already exists. Nothing was changed.`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);

  /**
   * One transaction: a half-finished bootstrap that created an organization but
   * no administrator would leave an install nobody can sign in to.
   */
  const organizationId = await db.transaction(async (tx) => {
    const [organization] = await tx
      .insert(organizations)
      .values({ name: orgName })
      .returning({ id: organizations.id });

    const [user] = await tx
      .insert(users)
      .values({ email, name: adminName, passwordHash })
      .returning({ id: users.id });

    await tx.insert(organizationMembers).values({
      organizationId: organization.id,
      userId: user.id,
      role: 'org_admin',
    });

    return organization.id;
  });

  console.log(`
Created organization "${orgName}" (${organizationId})
Administrator: ${email}`);

  if (generated) {
    // Printed once and never stored in clear -- only the scrypt digest is kept.
    console.log(`
  Generated password: ${password}

  Save it now. It cannot be recovered, only reset.`);
  }

  console.log('\nSign in at http://localhost:3000/login\n');
}

/**
 * Invoked as a promise chain rather than with top-level await: the package is
 * CommonJS, so a top-level await here fails to compile.
 */
main()
  .catch((error: unknown) => {
    // Never dump the error object: a driver error can echo the connection string.
    console.error(`Bootstrap failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
