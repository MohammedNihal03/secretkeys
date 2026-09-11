import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

import { getEnv } from '@/lib/env';

/**
 * Encryption at rest for stored credentials.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than decrypting to garbage that is then sent to a provider.
 *
 * Three properties beyond "it is encrypted":
 *
 *   1. **Bound to its organization.** The organization id is authenticated
 *      as additional data. A ciphertext copied into another tenant's row --
 *      by a bug or by someone with database write access -- fails to decrypt
 *      instead of lending one organization another's credential.
 *
 *   2. **Rotatable.** Each ciphertext records which key produced it. During a
 *      rotation the previous key is still accepted for decryption, so rows can
 *      be re-encrypted gradually instead of in one risky migration.
 *
 *   3. **Duplicate-detectable without being reversible.** Encryption uses a
 *      random IV, so equal secrets produce different ciphertexts. A separate
 *      keyed HMAC gives a stable fingerprint for equality checks that cannot be
 *      brute-forced from a database dump without the key.
 *
 * SECURITY: nothing in this module logs, and no error message includes a
 * plaintext, a ciphertext, or key material.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
/** 96-bit IV: the size GCM is specified for. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_VERSION = 'v1';

/** Separates the fingerprint key from the encryption key cryptographically. */
const FINGERPRINT_KDF_INFO = 'ai-db-observability:credential-fingerprint:v1';

/** What a ciphertext is bound to. Decrypting with a different context fails. */
export interface EncryptionContext {
  readonly organizationId: string;
  /** Distinguishes kinds of secret, so one can never be decrypted as another. */
  readonly purpose: 'api_key' | 'database_credentials';
}

/** Configuration is missing or malformed. The operator must act. */
export class CredentialKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialKeyError';
  }
}

/** A stored ciphertext could not be decrypted. */
export class CredentialDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialDecryptionError';
  }
}

interface KeyMaterial {
  /** Short, non-reversible identifier recorded in each ciphertext. */
  readonly id: string;
  readonly key: Buffer;
}

interface KeyRing {
  readonly current: KeyMaterial;
  /** Current first, then the previous key if one is configured. */
  readonly all: readonly KeyMaterial[];
}

/**
 * Decodes a configured key.
 *
 * Accepts standard base64 or base64url. The error names the variable and the
 * decoded length -- never the value.
 */
export function parseEncryptionKey(raw: string, variableName: string): Buffer {
  const trimmed = raw.trim();

  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) {
    throw new CredentialKeyError(`${variableName} must be base64-encoded.`);
  }

  const decoded = Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

  if (decoded.length !== KEY_BYTES) {
    throw new CredentialKeyError(
      `${variableName} must decode to exactly ${KEY_BYTES} bytes (it decodes to ${decoded.length}). Generate one with \`npm run generate:key\`.`
    );
  }

  return decoded;
}

function toMaterial(key: Buffer): KeyMaterial {
  // 32 bits of a hash of a 256-bit key: enough to tell configured keys apart,
  // useless for recovering the key.
  return { id: createHash('sha256').update(key).digest('hex').slice(0, 8), key };
}

let cachedRing: KeyRing | undefined;

function keyRing(): KeyRing {
  if (cachedRing) return cachedRing;

  const env = getEnv();

  if (!env.CREDENTIAL_ENCRYPTION_KEY) {
    throw new CredentialKeyError(
      'CREDENTIAL_ENCRYPTION_KEY is not set, so credentials cannot be stored or read. Generate one with `npm run generate:key` and add it to your environment.'
    );
  }

  const current = toMaterial(
    parseEncryptionKey(env.CREDENTIAL_ENCRYPTION_KEY, 'CREDENTIAL_ENCRYPTION_KEY')
  );

  const previous = env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS
    ? toMaterial(
        parseEncryptionKey(
          env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS,
          'CREDENTIAL_ENCRYPTION_KEY_PREVIOUS'
        )
      )
    : undefined;

  cachedRing = {
    current,
    all: previous && previous.id !== current.id ? [current, previous] : [current],
  };

  return cachedRing;
}

/**
 * Whether encryption is configured, without throwing.
 *
 * Lets the UI explain what is missing instead of failing a form submission.
 */
export function isEncryptionConfigured(): boolean {
  try {
    keyRing();
    return true;
  } catch {
    return false;
  }
}

/** The configuration problem, if any, as an operator-facing message. */
export function encryptionConfigurationError(): string | null {
  try {
    keyRing();
    return null;
  } catch (error) {
    return error instanceof CredentialKeyError ? error.message : 'Encryption is misconfigured.';
  }
}

/** Test-only: clears the cached key ring after changing the environment. */
export function resetCredentialKeyCache(): void {
  cachedRing = undefined;
}

function additionalData(context: EncryptionContext): Buffer {
  return Buffer.from(`ai-db-observability:${context.purpose}:${context.organizationId}`, 'utf8');
}

/**
 * Encrypts a secret.
 *
 * Output: `v1.<keyId>.<iv>.<tag>.<ciphertext>`, each part base64url. The dot
 * cannot appear in base64url, so the format parses unambiguously.
 */
export function encryptSecret(plaintext: string, context: EncryptionContext): string {
  const { current } = keyRing();
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, current.key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(additionalData(context));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    FORMAT_VERSION,
    current.id,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Decrypts a secret.
 *
 * Every failure -- unknown format, unconfigured key, wrong organization,
 * tampering -- throws `CredentialDecryptionError` with a message that reveals
 * none of the inputs.
 */
export function decryptSecret(payload: string, context: EncryptionContext): string {
  const parts = payload.split('.');

  if (parts.length !== 5 || parts[0] !== FORMAT_VERSION) {
    throw new CredentialDecryptionError('Stored credential is in an unrecognised format.');
  }

  const [, keyId, ivPart, tagPart, ciphertextPart] = parts;
  const material = keyRing().all.find((candidate) => candidate.id === keyId);

  if (!material) {
    throw new CredentialDecryptionError(
      'Stored credential was encrypted with a key that is not configured. If the key was rotated, set CREDENTIAL_ENCRYPTION_KEY_PREVIOUS.'
    );
  }

  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');

  // Checked explicitly: base64url decoding is lenient and would otherwise hand
  // a truncated IV or tag to the cipher.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new CredentialDecryptionError('Stored credential is corrupt.');
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, material.key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(additionalData(context));
    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Deliberately one message: distinguishing "wrong organization" from
    // "tampered" would tell an attacker which one they got.
    throw new CredentialDecryptionError(
      'Stored credential could not be decrypted: it belongs to a different organization, or it has been altered.'
    );
  }
}

/** True when a ciphertext was produced by a key other than the current one. */
export function needsReEncryption(payload: string): boolean {
  const keyId = payload.split('.')[1];
  return keyId !== keyRing().current.id;
}

/**
 * A stable, keyed fingerprint of a secret, for duplicate detection only.
 *
 * Scoped by organization, so the same secret registered in two organizations
 * yields unrelated fingerprints and a database dump reveals no cross-tenant
 * correlation. The HMAC key is derived from the encryption key with HKDF, so no
 * second secret has to be managed -- at the cost that rotating the encryption
 * key changes fingerprints, which a rotation must recompute.
 */
export function fingerprintSecret(secret: string, organizationId: string): string {
  const { current } = keyRing();

  const fingerprintKey = Buffer.from(
    hkdfSync('sha256', current.key, Buffer.alloc(0), FINGERPRINT_KDF_INFO, KEY_BYTES)
  );

  return createHmac('sha256', fingerprintKey)
    .update(organizationId, 'utf8')
    .update('\0')
    .update(secret, 'utf8')
    .digest('hex');
}
