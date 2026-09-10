import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password hashing.
 *
 * Uses scrypt from `node:crypto` rather than argon2 or bcrypt so the project
 * has no native build dependency -- self-hosters install this on whatever
 * platform they have, and a failed `node-gyp` build is a bad first experience.
 * scrypt is memory-hard and accepted by OWASP for password storage.
 *
 * SECURITY: never log a password or a digest, and never compare digests with
 * `===` -- use `verifyPassword`, which is constant-time.
 */

/**
 * `promisify` resolves to scrypt's 3-argument overload, which cannot pass
 * tuning parameters, so the options-taking signature is asserted explicitly.
 */
type ScryptFn = (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions
) => Promise<Buffer>;

const scrypt = promisify(scryptCallback) as ScryptFn;

/** Tuning parameters, read back out of a stored digest when verifying. */
interface ScryptParams {
  cost: number;
  blockSize: number;
  parallelization: number;
}

/**
 * OWASP-recommended scrypt parameters: cost 2^17, block size 8,
 * parallelisation 1.
 *
 * Stored inside each digest, so these can be raised later without
 * invalidating existing passwords -- old hashes keep verifying with the
 * parameters they were created with.
 */
const SCRYPT_PARAMS = {
  cost: 2 ** 17,
  blockSize: 8,
  parallelization: 1,
} as const;

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Node refuses a derivation whose memory need exceeds `maxmem`, which defaults
 * to 32MB. The requirement is `128 * cost * blockSize` (128MB at these
 * parameters), so it is raised explicitly with headroom.
 */
const MAX_MEM = 192 * 1024 * 1024;

/** Identifies the digest format, so a future algorithm change is detectable. */
const ALGORITHM_TAG = 'scrypt';

/**
 * Minimum length. Length dominates password strength, so this is enforced
 * rather than composition rules, which mostly push people toward `P@ssw0rd1`.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * scrypt's own limit is far higher, but hashing is memory-hard: accepting
 * unbounded input would let an unauthenticated request burn server memory.
 */
export const MAX_PASSWORD_LENGTH = 1024;

/**
 * Canonical form of an email address for storage and lookup.
 *
 * The local part is technically case-sensitive per RFC 5321, but treating it
 * that way in practice produces duplicate accounts for the same person, so the
 * whole address is lowercased -- as essentially every provider does.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return scrypt(password, salt, KEY_LENGTH, {
    N: params.cost,
    r: params.blockSize,
    p: params.parallelization,
    maxmem: MAX_MEM,
  });
}

/**
 * Hashes a password into a self-describing digest:
 * `scrypt$cost$blockSize$parallelization$salt$hash`.
 */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }

  const salt = randomBytes(SALT_LENGTH);
  const digest = await derive(password, salt, SCRYPT_PARAMS);

  return [
    ALGORITHM_TAG,
    SCRYPT_PARAMS.cost,
    SCRYPT_PARAMS.blockSize,
    SCRYPT_PARAMS.parallelization,
    salt.toString('base64'),
    digest.toString('base64'),
  ].join('$');
}

/**
 * Verifies a password against a stored digest in constant time.
 *
 * Returns `false` rather than throwing for a malformed or unknown-algorithm
 * digest, so a corrupt row cannot turn a failed login into a 500.
 */
export async function verifyPassword(password: string, storedDigest: string): Promise<boolean> {
  if (password.length > MAX_PASSWORD_LENGTH) return false;

  const parts = storedDigest.split('$');
  if (parts.length !== 6) return false;

  const [tag, cost, blockSize, parallelization, saltB64, digestB64] = parts;
  if (tag !== ALGORITHM_TAG) return false;

  const params: ScryptParams = {
    cost: Number(cost),
    blockSize: Number(blockSize),
    parallelization: Number(parallelization),
  };

  if (!Object.values(params).every((value) => Number.isInteger(value) && value > 0)) return false;

  // Reject parameters that would exceed the memory budget, rather than letting
  // a tampered digest trigger an allocation failure.
  if (128 * params.cost * params.blockSize > MAX_MEM) return false;

  let expected: Buffer;
  let actual: Buffer;

  try {
    expected = Buffer.from(digestB64, 'base64');
    actual = await derive(password, Buffer.from(saltB64, 'base64'), params);
  } catch {
    return false;
  }

  // `timingSafeEqual` throws on a length mismatch, which would itself leak.
  if (expected.length !== actual.length) return false;

  return timingSafeEqual(expected, actual);
}

/**
 * A digest of an unguessable value, for equalising sign-in timing.
 *
 * When an email does not exist there is nothing to verify against, and
 * returning early makes "no such user" measurably faster than "wrong
 * password" -- which lets an attacker enumerate valid accounts. The sign-in
 * path verifies against this instead so both branches do the same work.
 *
 * Computed lazily and cached, because it costs a full derivation.
 */
let dummyDigest: Promise<string> | undefined;

export function getDummyDigest(): Promise<string> {
  dummyDigest ??= hashPassword(randomBytes(32).toString('base64'));
  return dummyDigest;
}
