import { config as loadDotenv } from 'dotenv';
import { sql } from 'drizzle-orm';

import { closePool, getDb } from '@/lib/db/client';
import { aiProviders } from '@/lib/db/schema';
import { catalogueEntries } from '@/lib/providers/registry';

loadDotenv({ path: '.env.local', quiet: true });
loadDotenv({ path: '.env', quiet: true });

/**
 * Reconciles the `ai_providers` catalogue with the adapter registry.
 *
 * The catalogue is reference data describing which adapters exist in code, so
 * deriving it from the registry means the two cannot drift. Seeding it from a
 * SQL migration instead would also be impossible to do safely: a Postgres enum
 * value cannot be used in the same transaction that adds it, and Drizzle's
 * migrator runs all pending migrations in a single transaction.
 *
 * Idempotent -- run it after every `db:migrate`.
 */

async function main(): Promise<void> {
  const entries = catalogueEntries();
  const db = getDb();

  const result = await db
    .insert(aiProviders)
    .values(entries.map((entry) => ({ type: entry.type, name: entry.name })))
    /**
     * Update the display name on conflict, so renaming a provider in the
     * registry propagates. `type` is the stable identity; `name` is a label.
     */
    .onConflictDoUpdate({
      target: aiProviders.type,
      set: { name: sql`excluded.name`, updatedAt: new Date() },
    })
    .returning({ type: aiProviders.type, name: aiProviders.name });

  console.log(`Provider catalogue reconciled (${result.length}):`);
  for (const row of [...result].sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${row.name} (${row.type})`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(
      `Seeding providers failed: ${error instanceof Error ? error.message : 'unknown error'}`
    );
    process.exitCode = 1;
  })
  .finally(() => closePool());
