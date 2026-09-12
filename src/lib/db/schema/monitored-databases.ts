import {
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from './columns';
import { databaseTypeEnum, environmentEnum, healthStatusEnum, resourceStatusEnum } from './enums';
import { organizations } from './organizations';
import { projects } from './projects';

/**
 * An external database registered for monitoring.
 *
 * These are never reached from the browser and never share the dashboard's own
 * connection pool. Collectors open their own short-lived connections using the
 * least-privilege monitoring role stored here.
 *
 * SECURITY: `encryptedCredentials` is ciphertext and must never reach a client.
 * Connection metadata (host, port, database name, username) is stored in clear
 * because it is needed to display and diagnose a target, and is not a secret --
 * only the password is.
 */
export const monitoredDatabases = pgTable(
  'monitored_databases',
  {
    id: primaryId(),

    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),

    /** Operator-chosen label, e.g. "FYIND Production Primary". */
    name: text('name').notNull(),

    databaseType: databaseTypeEnum('database_type').notNull().default('postgresql'),

    host: text('host').notNull(),
    port: integer('port').notNull().default(5432),

    /** Name of the database to connect to on that host. */
    databaseName: text('database_name').notNull(),

    /** The monitoring role. Should be least-privilege, never a superuser. */
    username: text('username').notNull(),

    /**
     * Encrypted JSON holding the password and any optional TLS material.
     * A JSON payload rather than a single column so credentials can gain
     * fields (client certs) without a schema migration.
     */
    encryptedCredentials: text('encrypted_credentials').notNull(),

    /** Whether the collector must negotiate TLS to this target. */
    sslEnabled: boolean('ssl_enabled').notNull().default(true),

    environment: environmentEnum('environment').notNull(),

    /** Whether to collect from this target. Not health. */
    status: resourceStatusEnum('status').notNull().default('active'),

    /**
     * The result of the last connection check, the same way `api_keys` records
     * its last validation.
     *
     * A *snapshot* of the last attempt, not the metric history: the time series
     * lives in its own table, and a target that has never been reached needs an
     * answer before any history exists.
     */
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastCheckStatus: healthStatusEnum('last_check_status'),
    /** The server's message from the last check, already scrubbed of credentials. */
    lastCheckDetail: text('last_check_detail'),
    ...timestamps,
  },
  (table) => [
    // Same database-enforced organization isolation as `api_keys`.
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: 'monitored_databases_org_project_fk',
    }).onDelete('cascade'),

    unique('monitored_databases_org_name_unique').on(table.organizationId, table.name),

    /**
     * The same physical database must not be registered twice within an
     * organization, or its metrics would be collected and counted twice.
     */
    unique('monitored_databases_org_target_unique').on(
      table.organizationId,
      table.host,
      table.port,
      table.databaseName
    ),

    index('monitored_databases_org_idx').on(table.organizationId),
    index('monitored_databases_project_idx').on(table.projectId),
    index('monitored_databases_status_idx').on(table.status),
  ]
);

export type MonitoredDatabase = typeof monitoredDatabases.$inferSelect;
export type NewMonitoredDatabase = typeof monitoredDatabases.$inferInsert;

/** A monitored database with the secret-bearing column removed. */
export type SafeMonitoredDatabase = Omit<MonitoredDatabase, 'encryptedCredentials'>;
