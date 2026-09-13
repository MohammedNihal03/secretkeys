import { index, pgTable, text } from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from './columns';

/**
 * Failed sign-in attempts, for throttling password guessing.
 *
 * In the database rather than in process memory because the dashboard can run
 * as several instances: an in-memory counter would give an attacker a fresh
 * budget on every instance behind the load balancer.
 *
 * Nothing identifying is stored. `key_hash` is a SHA-256 of the throttle key --
 * derived from the normalized email and the client address -- so this table
 * cannot be read as a list of who tried to sign in, or from where. Rows are
 * append-only and short-lived: anything older than a day is pruned on the next
 * failure, so the table stays bounded without a separate job.
 *
 * `created_at` is the attempt time.
 */
export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: primaryId(),
    keyHash: text('key_hash').notNull(),
    ...timestamps,
  },
  (table) => [
    // The throttle query: how many failures for these keys since a moment.
    index('login_attempts_key_time_idx').on(table.keyHash, table.createdAt),
    // Pruning by age.
    index('login_attempts_time_idx').on(table.createdAt),
  ]
);

export type LoginAttempt = typeof loginAttempts.$inferSelect;
