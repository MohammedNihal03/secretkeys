import { pgTable, text, unique } from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from './columns';
import { resourceStatusEnum } from './enums';

/**
 * A person who can sign in.
 *
 * Deliberately NOT organization-scoped: the same person may belong to several
 * organizations with a different role in each. That relationship lives in
 * `organization_members`, which is also what grants any access at all -- a user
 * row on its own conveys no authority over any organization's data.
 *
 * SECURITY: `passwordHash` is a scrypt digest and must never leave the server.
 * Use the `SafeUser` type for anything a client can see.
 */
export const users = pgTable(
  'users',
  {
    id: primaryId(),

    /**
     * Stored lowercased so uniqueness and lookup are case-insensitive without
     * requiring the `citext` extension. Always normalise before comparing --
     * `normalizeEmail()` in `src/lib/auth/password.ts` is the single place that
     * decides what normalisation means.
     */
    email: text('email').notNull(),

    name: text('name').notNull(),

    /** scrypt digest, in the self-describing format produced by `hashPassword`. */
    passwordHash: text('password_hash').notNull(),

    /**
     * `disabled` blocks sign-in and invalidates existing sessions without
     * deleting the user, so their audit trail and memberships survive.
     */
    status: resourceStatusEnum('status').notNull().default('active'),
    ...timestamps,
  },
  (table) => [unique('users_email_unique').on(table.email)]
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/**
 * A user with the credential digest removed.
 *
 * Use this as the return type for anything reaching a client, so omitting the
 * hash is enforced by the compiler rather than remembered.
 */
export type SafeUser = Omit<User, 'passwordHash'>;
