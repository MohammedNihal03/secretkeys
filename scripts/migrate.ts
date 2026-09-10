import { config as loadDotenv } from 'dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

loadDotenv({ path: '.env.local', quiet: true });
loadDotenv({ path: '.env', quiet: true });

/**
 * Applies pending migrations.
 *
 * Uses Drizzle's own migrator rather than `drizzle-kit migrate` for two
 * reasons: `drizzle-kit` is a devDependency and so cannot be relied on in a
 * production deploy, and its CLI can exit non-zero while printing nothing,
 * which makes a broken migration very hard to diagnose. This reports the
 * actual Postgres error.
 */

const MIGRATIONS_FOLDER = './drizzle';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env.local and set it.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString, connectionTimeoutMillis: 15_000 });

  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
    console.log('Migrations applied.');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  /**
   * Report the driver's own message and SQLSTATE. Never dump the error object,
   * which can carry the connection string.
   */
  if (typeof error === 'object' && error !== null) {
    const e = error as { message?: string; code?: string; detail?: string; hint?: string };
    console.error(`Migration failed${e.code ? ` [${e.code}]` : ''}: ${e.message ?? 'unknown'}`);
    if (e.detail) console.error(`  detail: ${e.detail}`);
    if (e.hint) console.error(`  hint: ${e.hint}`);
  } else {
    console.error('Migration failed: unknown error');
  }

  process.exitCode = 1;
});
