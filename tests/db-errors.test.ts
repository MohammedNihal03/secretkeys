import { describe, expect, it } from 'vitest';

import {
  PG_ERROR,
  getConstraintName,
  getSqlState,
  isForeignKeyViolation,
  isUniqueViolation,
} from '@/lib/db/errors';

/**
 * Drizzle wraps driver errors, so the SQLSTATE lives on `error.cause` rather
 * than on the thrown error. Reading `.code` directly returns undefined, which
 * makes a constraint violation look like an unrelated failure -- these tests
 * pin the unwrapping behaviour.
 */

/** Mirrors how `pg` shapes an error and how Drizzle wraps it. */
function drizzleWrapped(code: string, constraint?: string): Error {
  const driverError = Object.assign(new Error('duplicate key value'), { code, constraint });
  return Object.assign(new Error('Failed query'), { cause: driverError });
}

describe('getSqlState', () => {
  it('reads the code from a bare driver error', () => {
    expect(getSqlState(Object.assign(new Error('x'), { code: '23505' }))).toBe('23505');
  });

  it('unwraps a Drizzle-wrapped driver error', () => {
    expect(getSqlState(drizzleWrapped('23503'))).toBe('23503');
  });

  it('unwraps a nested chain', () => {
    const inner = Object.assign(new Error('inner'), { code: '23514' });
    const middle = Object.assign(new Error('middle'), { cause: inner });
    const outer = Object.assign(new Error('outer'), { cause: middle });

    expect(getSqlState(outer)).toBe('23514');
  });

  it('ignores Node system error codes, which are not SQLSTATEs', () => {
    // Both live on `.code`, so length and character class are what separate them.
    const refused = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });

    expect(getSqlState(refused)).toBeUndefined();
  });

  it('returns undefined for values that are not errors', () => {
    for (const value of [undefined, null, 'boom', 42, {}, new Error('plain')]) {
      expect(getSqlState(value)).toBeUndefined();
    }
  });

  it('terminates on a self-referential cause chain', () => {
    const looped: { cause?: unknown } = {};
    looped.cause = looped;

    expect(getSqlState(looped)).toBeUndefined();
  });
});

describe('getConstraintName', () => {
  it('reports which constraint was violated', () => {
    expect(getConstraintName(drizzleWrapped('23505', 'api_keys_org_key_name_unique'))).toBe(
      'api_keys_org_key_name_unique'
    );
  });

  it('returns undefined when the driver did not name one', () => {
    expect(getConstraintName(drizzleWrapped('23505'))).toBeUndefined();
  });
});

describe('violation predicates', () => {
  it('identifies a unique violation through the wrapper', () => {
    expect(isUniqueViolation(drizzleWrapped(PG_ERROR.uniqueViolation))).toBe(true);
    expect(isUniqueViolation(drizzleWrapped(PG_ERROR.foreignKeyViolation))).toBe(false);
  });

  it('identifies a foreign key violation through the wrapper', () => {
    expect(isForeignKeyViolation(drizzleWrapped(PG_ERROR.foreignKeyViolation))).toBe(true);
    expect(isForeignKeyViolation(drizzleWrapped(PG_ERROR.uniqueViolation))).toBe(false);
  });

  it('does not treat a RESTRICT violation as a foreign key violation', () => {
    // ON DELETE RESTRICT raises 23001; only NO ACTION raises 23503. Conflating
    // them makes a blocked delete look like a missing parent row.
    expect(PG_ERROR.restrictViolation).not.toBe(PG_ERROR.foreignKeyViolation);
    expect(isForeignKeyViolation(drizzleWrapped(PG_ERROR.restrictViolation))).toBe(false);
  });
});
