/**
 * Drizzle schema for the dashboard's own database.
 *
 * The tenancy hierarchy this encodes:
 *
 *   Organization
 *    |-- Members             (user + role -- the sole source of authority)
 *    |-- Provider selection  (which providers this org tracks)
 *    |-- Projects
 *    |     |-- API Keys        (project + provider + environment)
 *    |     '-- Monitored Databases
 *    '-- (AI Providers are a global catalogue, not tenant data)
 *
 *   User                     (global; may belong to several organizations)
 *    '-- Sessions
 *
 * Every tenant-owned table carries `organization_id`, and child rows that
 * reference a project do so through a *composite* foreign key on
 * (organization_id, project_id). That makes cross-organization references
 * impossible at the database level rather than merely unlikely.
 *
 * `ai_usage` (Phase 6) is the AI metric time series and `database_metrics`
 * (Phase 8) the PostgreSQL one; alerts arrive in Phase 13.
 */

export * from './columns';
export * from './enums';
export * from './organizations';
export * from './users';
export * from './sessions';
export * from './organization-members';
export * from './projects';
export * from './ai-providers';
export * from './organization-providers';
export * from './api-keys';
export * from './monitored-databases';
export * from './collector-runs';
export * from './ai-usage';
export * from './database-metrics';
export * from './relations';
