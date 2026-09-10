import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from './columns';
import { users } from './users';

/**
 * A server-side session.
 *
 * SECURITY: only the SHA-256 *hash* of the session token is stored. The token
 * itself exists solely in the client's cookie, so a dump of this table cannot
 * be replayed to impersonate anyone. Sessions are server-side rather than
 * stateless JWTs specifically so that disabling a user or signing out takes
 * effect immediately instead of at token expiry.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: primaryId(),

    /** SHA-256 hex digest of the opaque token held by the client. */
    tokenHash: text('token_hash').notNull(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** Absolute expiry. A session is invalid past this instant regardless of activity. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    /** Drives idle expiry and lets the UI show where an account is signed in. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (table) => [
    // Lookup key on every authenticated request, so it must be unique and indexed.
    unique('sessions_token_hash_unique').on(table.tokenHash),

    // Revoking every session for a user.
    index('sessions_user_idx').on(table.userId),

    // Sweeping expired rows.
    index('sessions_expires_at_idx').on(table.expiresAt),
  ]
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
