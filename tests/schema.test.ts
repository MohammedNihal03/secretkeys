import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  aiProviders,
  apiKeys,
  monitoredDatabases,
  organizations,
  projects,
  type ApiKey,
  type SafeApiKey,
  type SafeMonitoredDatabase,
} from '@/lib/db/schema';

/**
 * Structural tests over the schema definition. No database required.
 *
 * These guard the invariants that are easy to break silently while editing the
 * schema -- particularly the composite foreign keys, which are the only thing
 * making cross-organization references impossible rather than merely unlikely.
 */

/** Tables that hold tenant-owned data and must therefore be organization-scoped. */
const TENANT_TABLES = [
  ['projects', projects],
  ['api_keys', apiKeys],
  ['monitored_databases', monitoredDatabases],
] as const;

/** Tables whose project reference must be guarded by a composite foreign key. */
const PROJECT_SCOPED_TABLES = [
  ['api_keys', apiKeys],
  ['monitored_databases', monitoredDatabases],
] as const;

describe('organization scoping', () => {
  it.each(TENANT_TABLES)('%s carries a non-null organization_id', (_name, table) => {
    const column = getTableConfig(table).columns.find((c) => c.name === 'organization_id');

    expect(column).toBeDefined();
    expect(column?.notNull).toBe(true);
  });

  it('does not scope the provider catalogue to an organization', () => {
    // Providers are global reference data. An organization_id here would imply
    // each tenant maintains its own adapter list, which is not the model.
    const columns = getTableConfig(aiProviders).columns.map((c) => c.name);

    expect(columns).not.toContain('organization_id');
  });
});

describe('cross-organization protection', () => {
  it.each(PROJECT_SCOPED_TABLES)(
    '%s references projects by (organization_id, project_id)',
    (_name, table) => {
      const composite = getTableConfig(table).foreignKeys.find(
        (fk) => fk.reference().columns.length === 2
      );

      expect(composite, 'expected a two-column foreign key').toBeDefined();

      const reference = composite!.reference();

      expect(reference.columns.map((c) => c.name)).toEqual(['organization_id', 'project_id']);
      expect(reference.foreignColumns.map((c) => c.name)).toEqual(['organization_id', 'id']);
      expect(reference.foreignTable).toBe(projects);
    }
  );

  it('gives projects the unique key those composite keys point at', () => {
    // Without this, the composite foreign keys above cannot be created at all.
    const target = getTableConfig(projects).uniqueConstraints.find(
      (constraint) => constraint.name === 'projects_org_id_unique'
    );

    expect(target).toBeDefined();
    expect(target?.columns.map((c) => c.name)).toEqual(['organization_id', 'id']);
  });
});

describe('credential storage', () => {
  it('stores the API key secret as ciphertext alongside a display-safe suffix', () => {
    const columns = getTableConfig(apiKeys).columns;
    const byName = (name: string) => columns.find((c) => c.name === name);

    expect(byName('encrypted_key')?.notNull).toBe(true);
    expect(byName('key_last4')?.notNull).toBe(true);

    // No column holds the plaintext secret.
    expect(columns.map((c) => c.name)).not.toContain('key');
  });

  it('leaves the fingerprint nullable so Phase 4 can populate it', () => {
    // Postgres treats NULLs as distinct in a unique constraint, so un-fingerprinted
    // rows coexist while the constraint still blocks duplicate real fingerprints.
    expect(getTableConfig(apiKeys).columns.find((c) => c.name === 'key_fingerprint')?.notNull).toBe(
      false
    );
  });

  it('keeps monitored-database credentials encrypted but connection metadata legible', () => {
    const columns = getTableConfig(monitoredDatabases).columns.map((c) => c.name);

    expect(columns).toContain('encrypted_credentials');
    // Host and username are needed to display and diagnose a target, and are
    // not secrets. A password column in clear would be.
    expect(columns).toContain('host');
    expect(columns).toContain('username');
    expect(columns).not.toContain('password');
  });

  it('excludes secret-bearing fields from the client-facing types', () => {
    expectTypeOf<SafeApiKey>().not.toHaveProperty('encryptedKey');
    expectTypeOf<SafeApiKey>().not.toHaveProperty('keyFingerprint');
    expectTypeOf<SafeMonitoredDatabase>().not.toHaveProperty('encryptedCredentials');

    // The suffix is what identifies a key in the UI, so it must survive.
    expectTypeOf<SafeApiKey>().toHaveProperty('keyLast4');
    expectTypeOf<ApiKey>().toHaveProperty('encryptedKey');
  });
});

describe('attribution chain', () => {
  it('lets a usage record resolve project, provider and environment from a key', () => {
    // "Which project uses this key? Which provider owns it? Which environment?"
    // must be answerable from the api_keys row alone.
    const columns = getTableConfig(apiKeys).columns;
    const required = ['project_id', 'provider_id', 'environment'];

    for (const name of required) {
      expect(columns.find((c) => c.name === name)?.notNull, `${name} must be non-null`).toBe(true);
    }
  });

  it('separates the provider-side project id from our own', () => {
    const columns = getTableConfig(apiKeys).columns.map((c) => c.name);

    // Conflating these would make provider-side grouping look like our attribution.
    expect(columns).toContain('project_id');
    expect(columns).toContain('provider_project_id');
  });
});

describe('timestamps', () => {
  it.each([
    ['organizations', organizations],
    ...TENANT_TABLES,
    ['ai_providers', aiProviders],
  ] as const)('%s records created_at and updated_at with a timezone', (_name, table) => {
    const columns = getTableConfig(table).columns;

    for (const name of ['created_at', 'updated_at']) {
      const column = columns.find((c) => c.name === name);
      expect(column?.notNull, `${name} must be non-null`).toBe(true);
      // Naive timestamps make metrics from different regions incomparable.
      expect(column?.getSQLType(), `${name} must be timestamptz`).toContain('with time zone');
    }
  });
});
