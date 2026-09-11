import { z } from 'zod';

/**
 * Server-side environment configuration.
 *
 * SECURITY: This module must never be imported from client components. Values
 * here include database credentials. Validation errors report variable *names*
 * only -- never their values -- so secrets cannot leak into logs or stack traces.
 */

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Connection string for the dashboard's OWN database. Never a monitored database. */
  DATABASE_URL: z
    .string()
    .min(1, 'must be set')
    .refine((value) => /^postgres(ql)?:\/\//.test(value), {
      message: 'must be a postgres:// or postgresql:// connection string',
    }),

  /** Enables TLS for the dashboard database connection. Required by most managed providers. */
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /**
   * 32-byte key, base64-encoded, that encrypts stored provider credentials.
   *
   * Optional at boot so the dashboard can start and explain what is missing;
   * required the moment a credential is stored or read. Its format is checked
   * in `src/lib/credentials/crypto.ts`, which can report a precise problem.
   *
   * LOSING THIS KEY MAKES EVERY STORED CREDENTIAL UNRECOVERABLE. Back it up
   * separately from the database.
   */
  CREDENTIAL_ENCRYPTION_KEY: optionalSecret(),

  /** The previous key during a rotation. Accepted for decryption only. */
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS: optionalSecret(),
});

/**
 * An optional secret where an empty value means "not set".
 *
 * `KEY=""` in an env file is common, and treating it as a present-but-invalid
 * value would stop the whole application from booting over a blank line.
 */
function optionalSecret() {
  return z
    .string()
    .optional()
    .transform((value) => (value && value.trim() ? value.trim() : undefined));
}

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  if (typeof window !== 'undefined') {
    throw new Error('env.ts must not be imported from client-side code');
  }

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    // Report names and messages only. Never interpolate the received value.
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(
      `Invalid environment configuration:\n${details}\n\nSee .env.example for the required variables.`
    );
  }

  return parsed.data;
}

let cached: Env | undefined;

/** Returns validated env, parsed once per process. */
export function getEnv(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test-only: clears the memoised env so a test can re-parse with different values. */
export function resetEnvCache(): void {
  cached = undefined;
}
