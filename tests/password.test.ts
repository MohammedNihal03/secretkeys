import { beforeAll, describe, expect, it } from 'vitest';

import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  normalizeEmail,
  verifyPassword,
} from '@/lib/auth/password';

/**
 * scrypt at the configured cost takes a few hundred milliseconds per
 * derivation, so a single hash is computed once and shared. Each test that
 * needs its own hash is doing so for a reason.
 */
const PASSWORD = 'correct horse battery staple';
let digest: string;

beforeAll(async () => {
  digest = await hashPassword(PASSWORD);
}, 30_000);

describe('hashPassword', () => {
  it('produces a self-describing digest with its parameters embedded', () => {
    const [tag, cost, blockSize, parallelization, salt, hash] = digest.split('$');

    expect(tag).toBe('scrypt');
    // Embedded so cost can be raised later without invalidating old passwords.
    expect(Number(cost)).toBe(2 ** 17);
    expect(Number(blockSize)).toBe(8);
    expect(Number(parallelization)).toBe(1);
    expect(salt).toBeTruthy();
    expect(hash).toBeTruthy();
  });

  it('never contains the password itself', () => {
    expect(digest).not.toContain(PASSWORD);
    expect(digest.toLowerCase()).not.toContain('horse');
  });

  it('salts, so the same password hashes differently every time', async () => {
    const again = await hashPassword(PASSWORD);

    // Identical digests would mean an unsalted hash and a rainbow-table risk.
    expect(again).not.toBe(digest);
    // Both must still verify.
    expect(await verifyPassword(PASSWORD, again)).toBe(true);
  }, 30_000);

  it('rejects a password below the minimum length', async () => {
    await expect(hashPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).rejects.toThrow(
      /at least 12 characters/
    );
  });

  it('rejects an absurdly long password', async () => {
    // Unbounded input would let an unauthenticated request burn server memory.
    await expect(hashPassword('a'.repeat(MAX_PASSWORD_LENGTH + 1))).rejects.toThrow(/at most/);
  });
});

describe('verifyPassword', () => {
  it('accepts the correct password', async () => {
    expect(await verifyPassword(PASSWORD, digest)).toBe(true);
  }, 30_000);

  it('rejects a wrong password', async () => {
    expect(await verifyPassword('wrong horse battery staple', digest)).toBe(false);
  }, 30_000);

  it('rejects a password differing only in case', async () => {
    expect(await verifyPassword(PASSWORD.toUpperCase(), digest)).toBe(false);
  }, 30_000);

  it('rejects an over-long candidate without hashing it', async () => {
    // Returns before any derivation, so this must be fast.
    const started = Date.now();
    expect(await verifyPassword('a'.repeat(MAX_PASSWORD_LENGTH + 1), digest)).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
  });

  describe('malformed digests', () => {
    // A corrupt row must fail the login, never throw a 500.
    it.each([
      ['empty', ''],
      ['too few fields', 'scrypt$131072$8$1$c2FsdA'],
      ['too many fields', 'scrypt$131072$8$1$c2FsdA$aGFzaA$extra'],
      ['unknown algorithm', 'bcrypt$131072$8$1$c2FsdA$aGFzaA'],
      ['non-numeric cost', 'scrypt$abc$8$1$c2FsdA$aGFzaA'],
      ['zero cost', 'scrypt$0$8$1$c2FsdA$aGFzaA'],
      ['negative cost', 'scrypt$-1$8$1$c2FsdA$aGFzaA'],
      ['plain text', 'hunter2'],
    ])('returns false for %s', async (_label, stored) => {
      expect(await verifyPassword(PASSWORD, stored)).toBe(false);
    });

    it('returns false rather than exhausting memory on an inflated cost', async () => {
      // A tampered digest asking for terabytes must be refused, not attempted.
      const started = Date.now();
      expect(await verifyPassword(PASSWORD, 'scrypt$1073741824$8$1$c2FsdA$aGFzaA')).toBe(false);
      expect(Date.now() - started).toBeLessThan(100);
    });
  });
});

describe('normalizeEmail', () => {
  it.each([
    ['  You@Example.COM  ', 'you@example.com'],
    ['ADMIN@ACME.IO', 'admin@acme.io'],
    ['already@lower.com', 'already@lower.com'],
  ])('normalises %j', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });

  it('makes differently-cased addresses collide', () => {
    // This is what stops two accounts existing for the same person.
    expect(normalizeEmail('Bob@Acme.com')).toBe(normalizeEmail('bob@acme.COM'));
  });
});
