import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CredentialDecryptionError,
  decryptSecret,
  resetCredentialKeyCache,
} from '@/lib/credentials/crypto';
import { getApiKey, listApiKeys } from '@/lib/credentials/repository';
import type { RegisterApiKeyValues } from '@/lib/credentials/schema';
import {
  loadCredentialForUse,
  registerApiKey,
  revalidateApiKey,
  setApiKeyStatus,
  updateApiKeyMetadata,
} from '@/lib/credentials/service';
import { closePool, getDb } from '@/lib/db/client';
import { aiProviders, apiKeys, organizations, projects } from '@/lib/db/schema';
import { resetEnvCache } from '@/lib/env';
import { setProviderEnabled } from '@/lib/providers/selection';

/**
 * API key registration, end to end against a real database.
 *
 *   npm run db:setup && npm run test:integration
 *
 * `fetch` is stubbed so no real provider is contacted; everything else --
 * encryption, persistence, constraints, tenant isolation -- is real.
 */

const RUN = Math.random().toString(36).slice(2, 10);
const db = getDb();

let orgA: string;
let orgB: string;
let projectA: string;
let projectB: string;
let ids: Record<string, string>;

let fetchMock: ReturnType<typeof vi.fn>;
let counter = 0;

function respond(status: number, body: unknown = { data: [] }) {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(body), { status }));
}

/** A unique, realistic-looking secret per call, so fingerprints never collide. */
function newSecret(prefix = 'sk-proj-'): string {
  counter += 1;
  return `${prefix}${RUN}${counter}${'Q'.repeat(24)}Z${counter}`;
}

function input(overrides: Partial<RegisterApiKeyValues> = {}): RegisterApiKeyValues {
  counter += 1;
  return {
    projectId: projectA,
    providerId: ids.openai,
    keyName: `key-${RUN}-${counter}`,
    environment: 'production',
    secret: newSecret(),
    providerKeyId: null,
    baseUrl: null,
    ...overrides,
  };
}

beforeAll(async () => {
  const [a, b] = await db
    .insert(organizations)
    .values([{ name: `Keys Org A ${RUN}` }, { name: `Keys Org B ${RUN}` }])
    .returning({ id: organizations.id });
  orgA = a.id;
  orgB = b.id;

  const [pa] = await db
    .insert(projects)
    .values({ organizationId: orgA, name: 'FYIND' })
    .returning({ id: projects.id });
  const [pb] = await db
    .insert(projects)
    .values({ organizationId: orgB, name: 'Lunad' })
    .returning({ id: projects.id });
  projectA = pa.id;
  projectB = pb.id;

  const catalogue = await db
    .select({ id: aiProviders.id, type: aiProviders.type })
    .from(aiProviders);
  ids = Object.fromEntries(catalogue.map((row) => [row.type, row.id]));
});

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  respond(200);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  for (const id of [orgA, orgB].filter(Boolean)) {
    await db.delete(organizations).where(eq(organizations.id, id));
  }
  await closePool();
});

async function storedRow(apiKeyId: string) {
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, apiKeyId));
  return row;
}

describe('registering a valid key', () => {
  it('stores it encrypted, fingerprinted and validated', async () => {
    const values = input();
    const result = await registerApiKey(orgA, values);

    expect(result).toMatchObject({ ok: true, outcome: 'valid' });
    if (!result.ok) return;

    const row = await storedRow(result.apiKeyId);

    expect(row.encryptedKey).not.toContain(values.secret);
    expect(row.encryptedKey.startsWith('v1.')).toBe(true);
    expect(row.keyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(row.keyLast4).toBe(values.secret.slice(-4));
    expect(row.lastValidationOutcome).toBe('valid');
    expect(row.lastValidatedAt).toBeInstanceOf(Date);
    expect(row.status).toBe('active');
  });

  it('decrypts back to the original secret for server-side use', async () => {
    const values = input();
    const result = await registerApiKey(orgA, values);
    if (!result.ok) throw new Error('setup failed');

    const loaded = await loadCredentialForUse(orgA, result.apiKeyId);

    expect(loaded && 'credential' in loaded && loaded.credential.apiKey).toBe(values.secret);
  });

  it('returns nothing about the secret from registration', async () => {
    const values = input();
    const result = await registerApiKey(orgA, values);

    expect(JSON.stringify(result)).not.toContain(values.secret);
  });
});

describe('display-safe reads', () => {
  it('never include ciphertext, fingerprint or the secret', async () => {
    const values = input();
    const result = await registerApiKey(orgA, values);
    if (!result.ok) throw new Error('setup failed');

    const list = await listApiKeys(orgA);
    const one = await getApiKey(orgA, result.apiKeyId);

    for (const item of [...list, one]) {
      expect(item).not.toHaveProperty('encryptedKey');
      expect(item).not.toHaveProperty('keyFingerprint');
    }

    expect(JSON.stringify(list)).not.toContain(values.secret);
    expect(JSON.stringify(one)).not.toContain(values.secret);
    expect(one?.project.name).toBe('FYIND');
    expect(one?.provider.type).toBe('openai');
  });

  it('can narrow the list to one project', async () => {
    const list = await listApiKeys(orgA, { projectId: projectA });

    expect(list.every((item) => item.project.id === projectA)).toBe(true);
  });
});

describe('rejections', () => {
  it('does not store a key the provider rejects', async () => {
    respond(401, { error: { message: 'Incorrect API key provided' } });
    const values = input();

    const result = await registerApiKey(orgA, values);

    expect(result.ok).toBe(false);
    if (!result.ok && 'errors' in result) expect(result.errors.secret).toMatch(/rejected/);

    const stored = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.organizationId, orgA), eq(apiKeys.keyName, values.keyName)));
    expect(stored).toHaveLength(0);
  });

  it('redacts a key the provider echoes back in its rejection', async () => {
    // A secret with no recognisable prefix, so only exact redaction can catch it.
    const secret = newSecret('');
    respond(401, { detail: { message: `invalid key: ${secret}` } });

    const result = await registerApiKey(orgA, input({ providerId: ids.elevenlabs, secret }));

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('refuses a provider the organization does not track, without calling it', async () => {
    await setProviderEnabled(orgA, ids.groq, false);

    const result = await registerApiKey(orgA, input({ providerId: ids.groq }));

    expect(result.ok).toBe(false);
    if (!result.ok && 'errors' in result) expect(result.errors.providerId).toMatch(/not tracked/);
    expect(fetchMock).not.toHaveBeenCalled();

    await setProviderEnabled(orgA, ids.groq, true);
  });

  it('refuses a project belonging to another organization', async () => {
    const result = await registerApiKey(orgA, input({ projectId: projectB }));

    expect(result.ok).toBe(false);
    if (!result.ok && 'errors' in result) expect(result.errors.projectId).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('unverifiable keys', () => {
  it.each([
    ['provider down', 503],
    ['rate limited', 429],
    ['forbidden (restricted key)', 403],
  ])('stores the key as unverified when %s', async (_label, status) => {
    respond(status, { error: { message: 'temporary' } });

    const result = await registerApiKey(orgA, input());

    expect(result).toMatchObject({ ok: true, outcome: 'unverified' });
    if (result.ok)
      expect((await storedRow(result.apiKeyId)).lastValidationOutcome).toBe('unverified');
  });

  it('never stores an echoed secret in the validation detail', async () => {
    const secret = newSecret('');
    respond(500, { error: { message: `upstream failure for ${secret}` } });

    const result = await registerApiKey(orgA, input({ providerId: ids.elevenlabs, secret }));
    if (!result.ok) throw new Error('expected an unverified save');

    const row = await storedRow(result.apiKeyId);
    expect(row.lastValidationDetail ?? '').not.toContain(secret);
  });

  it('stores a network failure as unverified', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    expect(await registerApiKey(orgA, input())).toMatchObject({ ok: true, outcome: 'unverified' });
  });
});

describe('duplicates', () => {
  it('names the existing key and skips the provider call', async () => {
    const first = input();
    const saved = await registerApiKey(orgA, first);
    expect(saved.ok).toBe(true);

    fetchMock.mockClear();
    const second = await registerApiKey(orgA, input({ secret: first.secret }));

    expect(second.ok).toBe(false);
    if (!second.ok && 'errors' in second) expect(second.errors.secret).toContain(first.keyName);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows the same key in a different organization', async () => {
    const shared = newSecret();
    const [pb2] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.organizationId, orgB));

    expect((await registerApiKey(orgA, input({ secret: shared }))).ok).toBe(true);
    expect((await registerApiKey(orgB, input({ secret: shared, projectId: pb2.id }))).ok).toBe(
      true
    );
  });

  it('rejects a duplicate name', async () => {
    const first = input();
    await registerApiKey(orgA, first);

    const result = await registerApiKey(orgA, input({ keyName: first.keyName }));

    expect(result.ok).toBe(false);
    if (!result.ok && 'errors' in result) expect(result.errors.keyName).toMatch(/already exists/);
  });
});

describe('Azure OpenAI endpoints', () => {
  it('requires an endpoint and makes no request without one', async () => {
    const result = await registerApiKey(orgA, input({ providerId: ids.azure_openai }));

    expect(result.ok).toBe(false);
    if (!result.ok && 'errors' in result) expect(result.errors.baseUrl).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a non-Azure endpoint without calling it', async () => {
    const result = await registerApiKey(
      orgA,
      input({ providerId: ids.azure_openai, baseUrl: 'https://169.254.169.254/latest' })
    );

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stores the normalized origin of an accepted endpoint', async () => {
    const result = await registerApiKey(
      orgA,
      input({
        providerId: ids.azure_openai,
        baseUrl: 'https://my-resource.openai.azure.com/openai/deployments/x?y=1',
      })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((await storedRow(result.apiKeyId)).baseUrl).toBe(
        'https://my-resource.openai.azure.com'
      );
    }
  });
});

describe('encryption configuration', () => {
  it('refuses to store anything when no key is configured', async () => {
    const env = process.env as Record<string, string | undefined>;
    const saved = env.CREDENTIAL_ENCRYPTION_KEY;

    delete env.CREDENTIAL_ENCRYPTION_KEY;
    resetEnvCache();
    resetCredentialKeyCache();

    try {
      const values = input();
      const result = await registerApiKey(orgA, values);

      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) expect(result.error).toMatch(/generate:key/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      env.CREDENTIAL_ENCRYPTION_KEY = saved;
      resetEnvCache();
      resetCredentialKeyCache();
    }
  });
});

describe('organization isolation', () => {
  it('hides a key from every other organization', async () => {
    const result = await registerApiKey(orgA, input());
    if (!result.ok) throw new Error('setup failed');

    expect(await getApiKey(orgB, result.apiKeyId)).toBeNull();
    expect(await loadCredentialForUse(orgB, result.apiKeyId)).toBeNull();
    expect(await setApiKeyStatus(orgB, result.apiKeyId, 'disabled')).toEqual({
      ok: false,
      error: 'This key no longer exists.',
    });
    expect((await revalidateApiKey(orgB, result.apiKeyId)).ok).toBe(false);

    // And the row is untouched by those attempts.
    expect((await storedRow(result.apiKeyId)).status).toBe('active');
  });

  it('makes ciphertext useless when moved into another organization', async () => {
    const values = input();
    const result = await registerApiKey(orgA, values);
    if (!result.ok) throw new Error('setup failed');

    const { encryptedKey } = await storedRow(result.apiKeyId);

    expect(() => decryptSecret(encryptedKey, { organizationId: orgB, purpose: 'api_key' })).toThrow(
      CredentialDecryptionError
    );
  });
});

describe('checking again', () => {
  it('records a new outcome', async () => {
    const result = await registerApiKey(orgA, input());
    if (!result.ok) throw new Error('setup failed');
    const before = (await storedRow(result.apiKeyId)).lastValidatedAt!;

    await new Promise((resolve) => setTimeout(resolve, 10));
    respond(401, { error: { message: 'key revoked at provider' } });

    const check = await revalidateApiKey(orgA, result.apiKeyId);

    expect(check).toMatchObject({ ok: true, outcome: 'invalid' });
    const row = await storedRow(result.apiKeyId);
    expect(row.lastValidationOutcome).toBe('invalid');
    expect(row.lastValidatedAt!.getTime()).toBeGreaterThan(before.getTime());
  });
});

describe('lifecycle', () => {
  it('disables and re-enables', async () => {
    const result = await registerApiKey(orgA, input());
    if (!result.ok) throw new Error('setup failed');

    expect(await setApiKeyStatus(orgA, result.apiKeyId, 'disabled')).toEqual({ ok: true });
    expect(await setApiKeyStatus(orgA, result.apiKeyId, 'active')).toEqual({ ok: true });
  });

  it('makes revocation permanent', async () => {
    const result = await registerApiKey(orgA, input());
    if (!result.ok) throw new Error('setup failed');

    expect(await setApiKeyStatus(orgA, result.apiKeyId, 'revoked')).toEqual({ ok: true });

    const reinstate = await setApiKeyStatus(orgA, result.apiKeyId, 'active');
    expect(reinstate.ok).toBe(false);
    expect((await storedRow(result.apiKeyId)).status).toBe('revoked');

    // A revoked key is not checked against the provider either.
    fetchMock.mockClear();
    expect((await revalidateApiKey(orgA, result.apiKeyId)).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('updates metadata without touching the secret', async () => {
    const values = input();
    const result = await registerApiKey(orgA, values);
    if (!result.ok) throw new Error('setup failed');
    const before = await storedRow(result.apiKeyId);

    expect(
      await updateApiKeyMetadata(orgA, result.apiKeyId, {
        keyName: `renamed-${RUN}-${counter}`,
        environment: 'staging',
        providerKeyId: 'key_attrib_1',
      })
    ).toEqual({ ok: true });

    const after = await storedRow(result.apiKeyId);
    expect(after.environment).toBe('staging');
    expect(after.providerKeyId).toBe('key_attrib_1');
    expect(after.encryptedKey).toBe(before.encryptedKey);
    expect(after.keyFingerprint).toBe(before.keyFingerprint);
  });
});

describe('provider and endpoint mismatch', () => {
  it('refuses an endpoint sent with a provider that does not use one, calling no one', async () => {
    // How a key typed for Azure OpenAI once ended up saved against Anthropic:
    // the form and the selected provider disagreed.
    const result = await registerApiKey(
      orgA,
      input({ providerId: ids.anthropic, baseUrl: 'https://my-resource.openai.azure.com' })
    );

    expect(result.ok).toBe(false);
    if (!result.ok && 'errors' in result) {
      expect(result.errors.providerId).toMatch(/does not use a resource endpoint/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
