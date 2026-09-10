import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { getEnv } from '@/lib/env';
import * as schema from './schema';

/**
 * Connection pool for the dashboard's own database.
 *
 * This pool is deliberately separate from any connection made to a *monitored*
 * database. Monitored databases are reached only by the collectors, using their
 * own short-lived, least-privilege connections.
 *
 * Both the pool and the Drizzle instance are created lazily, so importing this
 * module never requires a configured environment. That keeps `next build` from
 * needing database credentials.
 *
 * The pool is cached on `globalThis` so Next.js hot reloads in development do
 * not leak a new pool on every recompile.
 */

const POOL_CONFIG = {
  /** Kept modest: the dashboard should never be the reason a database runs out of connections. */
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
} as const;

declare global {
  var __observabilityPool: Pool | undefined;
  var __observabilityDb: ObservabilityDb | undefined;
}

function createPool(): Pool {
  const env = getEnv();

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
    ...POOL_CONFIG,
  });

  // An idle client erroring must not take down the process.
  pool.on('error', (error) => {
    console.error('[db] idle client error:', error.message);
  });

  return pool;
}

export function getPool(): Pool {
  globalThis.__observabilityPool ??= createPool();
  return globalThis.__observabilityPool;
}

/** Drizzle instance bound to the full schema, so relational queries are typed. */
export type ObservabilityDb = NodePgDatabase<typeof schema>;

export function getDb(): ObservabilityDb {
  globalThis.__observabilityDb ??= drizzle(getPool(), { schema });
  return globalThis.__observabilityDb;
}

/** Closes the pool and clears the cached Drizzle instance. Used by tests and graceful shutdown. */
export async function closePool(): Promise<void> {
  const pool = globalThis.__observabilityPool;
  globalThis.__observabilityPool = undefined;
  globalThis.__observabilityDb = undefined;
  await pool?.end();
}
