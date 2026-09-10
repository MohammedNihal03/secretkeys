import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getEnv, resetEnvCache } from '@/lib/env';

const KEYS = ['NODE_ENV', 'DATABASE_URL', 'DATABASE_SSL'] as const;

describe('environment validation', () => {
  // `process.env.NODE_ENV` is typed readonly, so mutate through a plain record.
  const mutableEnv = process.env as Record<string, string | undefined>;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((key) => [key, mutableEnv[key]]));
    for (const key of KEYS) delete mutableEnv[key];
    resetEnvCache();
  });

  afterEach(() => {
    for (const key of KEYS) {
      const previous = saved[key];
      if (previous === undefined) delete mutableEnv[key];
      else mutableEnv[key] = previous;
    }
    resetEnvCache();
  });

  it('accepts a valid postgres connection string', () => {
    mutableEnv.DATABASE_URL = 'postgresql://user:pass@localhost:5432/ai_observability';

    const env = getEnv();

    expect(env.DATABASE_URL).toBe('postgresql://user:pass@localhost:5432/ai_observability');
    expect(env.NODE_ENV).toBe('development');
    expect(env.DATABASE_SSL).toBe(false);
  });

  it('coerces DATABASE_SSL into a boolean', () => {
    mutableEnv.DATABASE_URL = 'postgres://localhost:5432/db';
    mutableEnv.DATABASE_SSL = 'true';

    expect(getEnv().DATABASE_SSL).toBe(true);
  });

  it('fails when DATABASE_URL is missing', () => {
    expect(() => getEnv()).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-postgres connection string', () => {
    mutableEnv.DATABASE_URL = 'mysql://localhost:3306/db';

    expect(() => getEnv()).toThrow(/postgres/);
  });

  // The whole point of reporting names instead of values: a bad connection
  // string must not paste credentials into logs or a stack trace.
  it('never includes the offending value in the error message', () => {
    const secret = 'sup3rs3cr3t-p4ssw0rd';
    mutableEnv.DATABASE_URL = `mysql://admin:${secret}@db.internal:3306/prod`;

    try {
      getEnv();
      expect.unreachable('expected validation to fail');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
      expect(message).not.toContain('db.internal');
      expect(message).toContain('DATABASE_URL');
    }
  });

  it('memoises the parsed environment', () => {
    mutableEnv.DATABASE_URL = 'postgres://localhost:5432/db';

    expect(getEnv()).toBe(getEnv());
  });
});
