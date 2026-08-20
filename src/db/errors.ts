/**
 * Reading SQLSTATE off a driver error.
 *
 * This project leans on the database to enforce things the application cannot
 * — the no-overlap exclusion constraint, the unique slug, the webhook event id
 * — so turning a constraint violation into a sentence a person can act on is
 * routine work here, not an edge case.
 *
 * Postgres errors arrive wrapped by node-postgres and are sometimes re-wrapped
 * by Drizzle, so the code can sit a couple of links down the `cause` chain.
 * Matching on SQLSTATE rather than on a message keeps this locale-proof.
 */

/** SQLSTATE 23505 — unique_violation. */
export const UNIQUE_VIOLATION = "23505";

/** SQLSTATE 23P01 — exclusion_violation. The no-double-booking constraint. */
export const EXCLUSION_VIOLATION = "23P01";

interface PostgresErrorShape {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
}

/** The Postgres error somewhere in the chain, or null. */
export function findPostgresError(
  error: unknown,
  code: string,
): PostgresErrorShape | null {
  let current: unknown = error;

  for (let depth = 0; current && depth < 5; depth += 1) {
    if (
      typeof current === "object" &&
      "code" in current &&
      (current as PostgresErrorShape).code === code
    ) {
      return current as PostgresErrorShape;
    }
    current = (current as PostgresErrorShape).cause;
  }

  return null;
}

/**
 * True when the error is a violation of one specific named constraint.
 *
 * The name matters: a transaction that inserts five rows can violate more than
 * one unique index, and "that address is taken" is only the right message for
 * one of them.
 */
export function isConstraintViolation(
  error: unknown,
  code: string,
  constraint: string,
): boolean {
  return findPostgresError(error, code)?.constraint === constraint;
}
