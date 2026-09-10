/**
 * Postgres error inspection.
 *
 * Drizzle wraps driver errors, so the SQLSTATE is not on the thrown error but
 * on its `cause`. Reading `error.code` directly yields `undefined` and makes a
 * constraint violation look like an unrelated failure -- so always go through
 * `getSqlState`.
 */

/** SQLSTATE codes this application distinguishes. */
export const PG_ERROR = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  /**
   * Raised by ON DELETE RESTRICT. Distinct from foreignKeyViolation, which is
   * what NO ACTION raises -- asserting the wrong one of these is an easy
   * mistake, since both describe a blocked delete.
   */
  restrictViolation: '23001',
  notNullViolation: '23502',
  checkViolation: '23514',
  /** Raised by Postgres as "sorry, too many clients already". */
  tooManyConnections: '53300',
  /** A monitoring query exceeded `statement_timeout`. */
  queryCanceled: '57014',
} as const;

export type PgErrorCode = (typeof PG_ERROR)[keyof typeof PG_ERROR];

/** Maximum depth walked when unwrapping `cause` chains, as a loop guard. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Returns the Postgres SQLSTATE for an error, unwrapping driver and ORM
 * wrappers, or `undefined` if this is not a Postgres error.
 */
export function getSqlState(error: unknown): string | undefined {
  let current = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;

    const code = (current as { code?: unknown }).code;
    // Node system errors also use `code`, but with a string label like
    // 'ECONNREFUSED'. SQLSTATE is always five characters.
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;

    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

/** The name of the constraint a violation was raised against, when available. */
export function getConstraintName(error: unknown): string | undefined {
  let current = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;

    const constraint = (current as { constraint?: unknown }).constraint;
    if (typeof constraint === 'string') return constraint;

    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

export function isUniqueViolation(error: unknown): boolean {
  return getSqlState(error) === PG_ERROR.uniqueViolation;
}

export function isForeignKeyViolation(error: unknown): boolean {
  return getSqlState(error) === PG_ERROR.foreignKeyViolation;
}
