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

/**
 * SQLSTATE 23503 — foreign_key_violation.
 *
 * `appointments` references services and staff with ON DELETE RESTRICT, so
 * this is what the database says when someone tries to delete a service that
 * an appointment still points at. The admin checks first and explains; this
 * code is the backstop for the race between the check and the delete.
 */
export const FOREIGN_KEY_VIOLATION = "23503";

/**
 * SQLSTATE 23514 — check_violation.
 *
 * `appointments_customer_required_once_booked` is the one that matters: an
 * appointment may be anonymous only while it is a hold. The database refuses
 * anything else, so no code path can confirm a booking that belongs to nobody.
 */
export const CHECK_VIOLATION = "23514";

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
