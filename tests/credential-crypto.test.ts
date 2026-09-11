import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CredentialDecryptionError,
  CredentialKeyError,
  decryptSecret,
  encryptSecret,
  encryptionConfigurationError,
  fingerprintSecret,
  isEncryptionConfigured,
  needsReEncryption,
  parseEncryptionKey,
  resetCredentialKeyCache,
} from '@/lib/credentials/crypto';
import { maskedKey, secretSuffix } from '@/lib/credentials/mask';
import { resetEnvCache } from '@/lib/env';

/**
 * Credential encryption.
 *
 * The properties that matter are asserted directly: ciphertext is bound to its
 * organization, tampering is detected, rotation works, and no error message
 * ever carries a plaintext or key material.
 */

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

const ORG_1 = '11111111-1111-1111-1111-111111111111';
const ORG_2 = '22222222-2222-2222-2222-222222222222';
const CONTEXT = { organizationId: ORG_1, purpose: 'api_key' } as const;

const SECRET = 'sk-proj-THIS-IS-A-TEST-SECRET-abc123XYZ';

const env = process.env as Record<string, string | undefined>;
const KEYS = ['DATABASE_URL', 'CREDENTIAL_ENCRYPTION_KEY', 'CREDENTIAL_ENCRYPTION_KEY_PREVIOUS'];
let saved: Record<string, string | undefined>;

function configure(current?: string, previous?: string) {
  env.DATABASE_URL = 'postgres://localhost:5432/test';
  if (current === undefined) delete env.CREDENTIAL_ENCRYPTION_KEY;
  else env.CREDENTIAL_ENCRYPTION_KEY = current;
  if (previous === undefined) delete env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS;
  else env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS = previous;
  resetEnvCache();
  resetCredentialKeyCache();
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, env[key]]));
  configure(KEY_A);
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete env[key];
    else env[key] = saved[key];
  }
  resetEnvCache();
  resetCredentialKeyCache();
});

/** Replaces one character of a dot-separated part, keeping it valid base64url. */
function tamper(payload: string, partIndex: number): string {
  const parts = payload.split('.');
  const part = parts[partIndex];
  const flipped = part[0] === 'A' ? 'B' : 'A';
  parts[partIndex] = flipped + part.slice(1);
  return parts.join('.');
}

describe('round trip', () => {
  it('decrypts what it encrypts', () => {
    expect(decryptSecret(encryptSecret(SECRET, CONTEXT), CONTEXT)).toBe(SECRET);
  });

  it('handles non-ASCII secrets', () => {
    const unicode = 'clé-秘密-🔑-0123456789abcdef';
    expect(decryptSecret(encryptSecret(unicode, CONTEXT), CONTEXT)).toBe(unicode);
  });

  it('uses the versioned five-part format', () => {
    const parts = encryptSecret(SECRET, CONTEXT).split('.');

    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('v1');
    expect(parts[1]).toMatch(/^[0-9a-f]{8}$/);
  });

  it('never contains the plaintext', () => {
    const payload = encryptSecret(SECRET, CONTEXT);

    expect(payload).not.toContain(SECRET);
    expect(payload).not.toContain('TEST-SECRET');
  });

  it('produces a different ciphertext each time for the same secret', () => {
    // A random IV per encryption; equal ciphertexts would leak equal secrets.
    expect(encryptSecret(SECRET, CONTEXT)).not.toBe(encryptSecret(SECRET, CONTEXT));
  });
});

describe('binding to organization and purpose', () => {
  it('refuses to decrypt under a different organization', () => {
    const payload = encryptSecret(SECRET, CONTEXT);

    // A ciphertext copied into another tenant's row must be useless there.
    expect(() => decryptSecret(payload, { ...CONTEXT, organizationId: ORG_2 })).toThrow(
      CredentialDecryptionError
    );
  });

  it('refuses to decrypt as a different kind of secret', () => {
    const payload = encryptSecret(SECRET, CONTEXT);

    expect(() => decryptSecret(payload, { ...CONTEXT, purpose: 'database_credentials' })).toThrow(
      CredentialDecryptionError
    );
  });
});

describe('tamper detection', () => {
  it.each([
    ['ciphertext', 4],
    ['auth tag', 3],
    ['iv', 2],
  ])('rejects an altered %s', (_label, index) => {
    const payload = encryptSecret(SECRET, CONTEXT);

    expect(() => decryptSecret(tamper(payload, index), CONTEXT)).toThrow(CredentialDecryptionError);
  });

  it.each([
    ['empty', ''],
    ['wrong version', 'v2.aaaaaaaa.a.b.c'],
    ['too few parts', 'v1.aaaaaaaa.abc'],
    ['plaintext', SECRET],
  ])('rejects a malformed payload: %s', (_label, payload) => {
    expect(() => decryptSecret(payload, CONTEXT)).toThrow(CredentialDecryptionError);
  });

  it('rejects a truncated IV or tag before touching the cipher', () => {
    const parts = encryptSecret(SECRET, CONTEXT).split('.');
    parts[2] = parts[2].slice(0, 4);

    expect(() => decryptSecret(parts.join('.'), CONTEXT)).toThrow(/corrupt/);
  });

  it('never includes the secret or ciphertext in an error message', () => {
    const payload = encryptSecret(SECRET, CONTEXT);

    try {
      decryptSecret(payload, { ...CONTEXT, organizationId: ORG_2 });
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(payload.split('.')[4]);
    }
  });
});

describe('key rotation', () => {
  it('cannot decrypt with a key that is not configured', () => {
    const payload = encryptSecret(SECRET, CONTEXT);
    configure(KEY_B);

    expect(() => decryptSecret(payload, CONTEXT)).toThrow(/not configured/);
  });

  it('decrypts with the previous key during a rotation', () => {
    const oldPayload = encryptSecret(SECRET, CONTEXT);
    configure(KEY_B, KEY_A);

    expect(decryptSecret(oldPayload, CONTEXT)).toBe(SECRET);
    expect(needsReEncryption(oldPayload)).toBe(true);
  });

  it('encrypts new secrets with the current key', () => {
    configure(KEY_B, KEY_A);
    const fresh = encryptSecret(SECRET, CONTEXT);

    expect(needsReEncryption(fresh)).toBe(false);

    // And the previous key alone cannot read it.
    configure(KEY_A);
    expect(() => decryptSecret(fresh, CONTEXT)).toThrow(CredentialDecryptionError);
  });
});

describe('configuration', () => {
  it('reports a missing key without throwing from the check itself', () => {
    configure(undefined);

    expect(isEncryptionConfigured()).toBe(false);
    expect(encryptionConfigurationError()).toMatch(/npm run generate:key/);
    expect(() => encryptSecret(SECRET, CONTEXT)).toThrow(CredentialKeyError);
  });

  it('treats an empty value as not set rather than failing to boot', () => {
    configure('   ');

    expect(isEncryptionConfigured()).toBe(false);
  });

  it('reports configured when a valid key is present', () => {
    expect(isEncryptionConfigured()).toBe(true);
    expect(encryptionConfigurationError()).toBeNull();
  });

  it('accepts base64url as well as standard base64', () => {
    const urlSafe = Buffer.alloc(32, 250).toString('base64url');

    expect(parseEncryptionKey(urlSafe, 'K')).toHaveLength(32);
  });

  it.each([
    ['not base64', 'this is not base64!'],
    ['too short', Buffer.alloc(16, 1).toString('base64')],
    ['too long', Buffer.alloc(64, 1).toString('base64')],
  ])('rejects a key that is %s', (_label, value) => {
    expect(() => parseEncryptionKey(value, 'CREDENTIAL_ENCRYPTION_KEY')).toThrow(
      CredentialKeyError
    );
  });

  it('never echoes a misconfigured key value', () => {
    const wrong = Buffer.alloc(20, 7).toString('base64');
    configure(wrong);

    const message = encryptionConfigurationError() ?? '';
    expect(message).toContain('CREDENTIAL_ENCRYPTION_KEY');
    expect(message).not.toContain(wrong);
  });
});

describe('fingerprints', () => {
  it('is deterministic for the same secret and organization', () => {
    expect(fingerprintSecret(SECRET, ORG_1)).toBe(fingerprintSecret(SECRET, ORG_1));
  });

  it('differs between organizations, so dumps reveal no cross-tenant link', () => {
    expect(fingerprintSecret(SECRET, ORG_1)).not.toBe(fingerprintSecret(SECRET, ORG_2));
  });

  it('differs for different secrets', () => {
    expect(fingerprintSecret(SECRET, ORG_1)).not.toBe(fingerprintSecret(`${SECRET}x`, ORG_1));
  });

  it('is a 64-character hex digest that does not contain the secret', () => {
    const fingerprint = fingerprintSecret(SECRET, ORG_1);

    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).not.toContain('TEST');
  });

  it('depends on the configured key, so it cannot be computed without it', () => {
    const withA = fingerprintSecret(SECRET, ORG_1);
    configure(KEY_B);

    expect(fingerprintSecret(SECRET, ORG_1)).not.toBe(withA);
  });
});

describe('masking', () => {
  it('keeps only the last four characters', () => {
    expect(secretSuffix(SECRET)).toBe('3XYZ');
    expect(maskedKey(secretSuffix(SECRET))).toBe('••••3XYZ');
  });
});
