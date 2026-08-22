import "server-only";

import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import { EXCLUSION_VIOLATION, findPostgresError } from "@/db/errors";
import { appointments, services, type Appointment } from "@/db/schema";

import { buildBlockingRange, type BlockingRange } from "./slot";

/**
 * The only module in the codebase that writes to `appointments`.
 *
 * Everything here rests on one idea: THE DATABASE DECIDES. No function below
 * asks "is this slot free?" and then acts on the answer, because between the
 * question and the action another request can book the same time. Instead each
 * function writes optimistically and lets the exclusion constraint
 * `appointments_no_overlap` (migration 0002) arbitrate, then translates the
 * resulting Postgres error into a typed domain error.
 *
 * The two-step shape of every write is:
 *
 *   1. DELETE expired holds that would collide — in the SAME transaction.
 *   2. INSERT or UPDATE, and let the constraint decide.
 *
 * Step 1 is mandatory and is not an optimisation. The constraint predicate
 * cannot reference now() (it must be IMMUTABLE), so an expired hold still
 * occupies its slot until a statement physically removes the row. See the long
 * comment in drizzle/0002_appointments_no_overlap.sql.
 */

/** How long a customer gets to complete checkout before the slot is released. */
export const DEFAULT_HOLD_MINUTES = 8;

/**
 * Domain part of the iCalendar UID. The UUID alone is already globally unique;
 * this just makes the UID readable in a calendar client's raw view.
 */
const ICS_UID_DOMAIN = "openings";

/* ===========================================================================
   Errors
   =========================================================================== */

/**
 * The slot was taken between the customer choosing it and us writing it.
 *
 * Carries the requested time so the caller can say what failed and offer the
 * nearest alternatives, rather than surfacing a Postgres error string.
 */
export class SlotTakenError extends Error {
  readonly code = "SLOT_TAKEN" as const;

  constructor(
    readonly requested: {
      staffId: string;
      serviceId: string;
      startsAt: Date;
      endsAt: Date;
      slot: string;
    },
  ) {
    super(
      `That time was just taken (staff ${requested.staffId}, ` +
        `${requested.startsAt.toISOString()} – ${requested.endsAt.toISOString()}).`,
    );
    this.name = "SlotTakenError";
  }
}

/** The hold is gone — it expired and was reclaimed, or was already released. */
export class HoldNotFoundError extends Error {
  readonly code = "HOLD_NOT_FOUND" as const;

  constructor(readonly appointmentId: string) {
    super(`No held appointment with id ${appointmentId}.`);
    this.name = "HoldNotFoundError";
  }
}

/** The service does not exist, is inactive, or belongs to another business. */
export class ServiceNotFoundError extends Error {
  readonly code = "SERVICE_NOT_FOUND" as const;

  constructor(readonly serviceId: string) {
    super(`No bookable service with id ${serviceId}.`);
    this.name = "ServiceNotFoundError";
  }
}

/**
 * The one error the whole design hinges on: SQLSTATE 23P01, raised by
 * `appointments_no_overlap` when a concurrent transaction got the slot first.
 * Unwrapping it lives in src/db/errors.ts, because the same trick is needed
 * wherever a constraint is doing the work the application deliberately is not.
 */
function isExclusionViolation(error: unknown): boolean {
  return findPostgresError(error, EXCLUSION_VIOLATION) !== null;
}

/* ===========================================================================
   The manage token — the customer's proof that an appointment is theirs
   =========================================================================== */

/**
 * SHA-256 of a manage token, hex.
 *
 * The row stores only this. The plaintext goes into the customer's manage link
 * and, for the eight minutes a hold lasts, into an httpOnly cookie — because
 * "release the slot I am holding" and "cancel my appointment" are the same
 * question ("is this appointment yours?") asked at two different times, and
 * inventing a second secret to answer it twice would mean two things to leak
 * instead of one.
 */
export function hashManageToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Constant-time comparison of a presented token against a stored hash.
 *
 * `===` on the digests would leak, through timing, how many leading bytes a
 * guess got right. That is a real attack against a 32-byte secret and it costs
 * one function call to remove.
 */
export function manageTokenMatches(token: string, storedHash: string): boolean {
  const presented = Buffer.from(hashManageToken(token), "hex");
  const stored = Buffer.from(storedHash, "hex");

  return (
    presented.length === stored.length && timingSafeEqual(presented, stored)
  );
}

/* ===========================================================================
   Shared SQL
   =========================================================================== */

/**
 * Remove expired holds that would collide with `slot` for this staff member.
 *
 * This is the lazy half of hold expiry. It runs inside the caller's
 * transaction, immediately before the write it protects, so there is no window
 * in which another session could slip in between the delete and the insert —
 * and if it deletes nothing, the constraint simply rejects the write, which is
 * the correct outcome.
 *
 * `excludeAppointmentId` keeps a confirmation from sweeping away the very hold
 * it is trying to confirm.
 */
function deleteCollidingExpiredHolds(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  staffId: string,
  slot: string,
  excludeAppointmentId?: string,
) {
  return tx.execute(sql`
    DELETE FROM ${appointments}
     WHERE ${appointments.status} = 'held'
       AND ${appointments.holdExpiresAt} < now()
       AND ${appointments.staffId} = ${staffId}
       AND ${appointments.slot} && ${slot}::tstzrange
       ${
         excludeAppointmentId
           ? sql`AND ${appointments.id} <> ${excludeAppointmentId}`
           : sql``
       }
  `);
}

/* ===========================================================================
   Create a hold
   =========================================================================== */

export interface CreateHoldInput {
  businessId: string;
  staffId: string;
  serviceId: string;
  /**
   * NULL for a hold taken from the public picker.
   *
   * The slot is reserved the moment a time is tapped, which is before the
   * customer has typed anything — so there is nobody to point at yet. The
   * CHECK constraint on the table allows this for `held` and for nothing else.
   */
  customerId?: string | null;
  /** Customer-facing start instant. */
  startsAt: Date | string;
  /** Defaults to DEFAULT_HOLD_MINUTES. */
  holdMinutes?: number;
  customerNote?: string | null;
}

export interface HeldAppointment {
  appointment: Appointment;
  /**
   * The PLAINTEXT manage token. Only ever returned here, never stored — the
   * row keeps its SHA-256. Put it in the customer's link and then forget it.
   */
  manageToken: string;
  range: BlockingRange;
}

/**
 * Reserve a slot.
 *
 * Writes a real `held` row, which the exclusion constraint covers, so the time
 * is genuinely unavailable to everyone else for the duration of the hold —
 * not merely marked as pending in the UI.
 *
 * Throws `SlotTakenError` if the slot went while the customer was deciding.
 */
export async function createHold(
  db: Db,
  input: CreateHoldInput,
): Promise<HeldAppointment> {
  return takeHold(db, input, null);
}

/**
 * Move a customer from one held slot to another, ATOMICALLY.
 *
 * A customer changing their mind between 14:00 and 15:00 must never be holding
 * both, and must never briefly be holding neither. Two round trips —
 * release, then create — can produce both of those: release-then-crash loses
 * the customer their slot with nothing to show for it, and create-then-release
 * has them occupying two slots while somebody else is told the day is full. So
 * both happen in ONE transaction:
 *
 *   1. DELETE the previous hold (after checking it is genuinely theirs).
 *   2. DELETE expired holds colliding with the new range.
 *   3. INSERT the new hold, and let the constraint arbitrate.
 *
 * If step 3 loses the race, the whole transaction rolls back and the customer
 * still has their ORIGINAL slot — the outcome they would obviously prefer over
 * being left with nothing because they looked at an alternative.
 *
 * Deleting first also lets somebody shuffle WITHIN their own hold — 14:00 to
 * 14:15 on a 90-minute service overlaps itself, and without step 1 the
 * constraint would refuse to let a customer move out of their own way.
 */
export async function moveHold(
  db: Db,
  input: CreateHoldInput,
  previous: { appointmentId: string; manageToken: string },
): Promise<HeldAppointment> {
  return takeHold(db, input, previous);
}

/** The one implementation behind both entry points above. */
async function takeHold(
  db: Db,
  input: CreateHoldInput,
  previous: { appointmentId: string; manageToken: string } | null,
): Promise<HeldAppointment> {
  const holdMinutes = input.holdMinutes ?? DEFAULT_HOLD_MINUTES;

  const manageToken = randomBytes(32).toString("base64url");
  const manageTokenHash = hashManageToken(manageToken);
  const icsUid = `${randomUUID()}@${ICS_UID_DOMAIN}`;

  try {
    return await db.transaction(async (tx) => {
      // Read the service inside the transaction so the buffers written into
      // the range are the ones the database currently holds.
      const [service] = await tx
        .select()
        .from(services)
        .where(
          and(
            eq(services.id, input.serviceId),
            eq(services.businessId, input.businessId),
            eq(services.isActive, true),
          ),
        )
        .limit(1);

      if (!service) {
        throw new ServiceNotFoundError(input.serviceId);
      }

      const range = buildBlockingRange(input.startsAt, service);

      // STEP 0 — give back the slot this customer already had, if any. Missing
      // or not theirs is not an error: the hold may have expired and been
      // swept while they were deciding, and the thing they actually want is
      // the new slot.
      if (previous) {
        await deleteOwnHold(tx, previous.appointmentId, previous.manageToken);
      }

      // STEP 1 — clear expired holds that would otherwise block us.
      await deleteCollidingExpiredHolds(tx, input.staffId, range.slot);

      // STEP 2 — write, and let the constraint arbitrate.
      const [appointment] = await tx
        .insert(appointments)
        .values({
          businessId: input.businessId,
          staffId: input.staffId,
          serviceId: input.serviceId,
          customerId: input.customerId ?? null,
          slot: range.slot,
          startsAt: range.startsAt,
          endsAt: range.endsAt,
          status: "held",
          // Computed by the database so the hold deadline and the `now()` in
          // the sweep above are read from the same clock.
          holdExpiresAt: sql`now() + make_interval(mins => ${holdMinutes}::int)`,
          priceCents: service.priceCents,
          depositCents: depositFor(service),
          icsUid,
          icsSequence: 0,
          manageTokenHash,
          customerNote: input.customerNote ?? null,
        })
        .returning();

      return { appointment, manageToken, range };
    });
  } catch (error) {
    if (isExclusionViolation(error)) {
      const range = await rebuildRangeForError(db, input);
      throw new SlotTakenError({
        staffId: input.staffId,
        serviceId: input.serviceId,
        startsAt: range.startsAt,
        endsAt: range.endsAt,
        slot: range.slot,
      });
    }
    throw error;
  }
}

/**
 * Delete a held row, but only if the presented token really owns it.
 *
 * Returns whether anything went. Reads the row first because the check is a
 * constant-time comparison in Node rather than a SQL equality — see
 * `manageTokenMatches`.
 */
async function deleteOwnHold(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  appointmentId: string,
  manageToken: string,
): Promise<boolean> {
  const [row] = await tx
    .select({
      id: appointments.id,
      manageTokenHash: appointments.manageTokenHash,
    })
    .from(appointments)
    .where(
      and(eq(appointments.id, appointmentId), eq(appointments.status, "held")),
    )
    .limit(1);

  if (!row || !manageTokenMatches(manageToken, row.manageTokenHash)) {
    return false;
  }

  const deleted = await tx
    .delete(appointments)
    .where(
      and(eq(appointments.id, appointmentId), eq(appointments.status, "held")),
    )
    .returning({ id: appointments.id });

  return deleted.length > 0;
}

/**
 * The transaction that computed the range has already rolled back by the time
 * we build the error, so recompute it for the error payload. Best effort: if
 * the service has since vanished, fall back to a zero-buffer range so the
 * caller still learns which time failed.
 */
async function rebuildRangeForError(
  db: Db,
  input: CreateHoldInput,
): Promise<BlockingRange> {
  const [service] = await db
    .select()
    .from(services)
    .where(eq(services.id, input.serviceId))
    .limit(1);

  return buildBlockingRange(
    input.startsAt,
    service ?? { durationMin: 0, bufferBeforeMin: 0, bufferAfterMin: 0 },
  );
}

/** Deposit owed at booking time, in integer cents. */
function depositFor(service: {
  depositType: "none" | "flat" | "percent";
  depositValue: number;
  priceCents: number;
}): number {
  switch (service.depositType) {
    case "none":
      return 0;
    case "flat":
      return service.depositValue;
    case "percent":
      // Round half up; the business is never short a cent.
      return Math.round((service.priceCents * service.depositValue) / 100);
  }
}

/* ===========================================================================
   Confirm a hold
   =========================================================================== */

/**
 * Turn a hold into a confirmed appointment.
 *
 * Called only from the verified Stripe webhook — the success redirect is not
 * proof of payment.
 *
 * NOTE ON EXPIRED-BUT-PRESENT HOLDS: a hold whose `hold_expires_at` has passed
 * but whose row still exists is still ours. Nothing released it, and the
 * constraint kept the slot reserved the whole time, so confirming it is the
 * correct outcome rather than an error. Only a hold that has actually been
 * deleted is lost, and that surfaces as `HoldNotFoundError`. Re-acquiring a
 * lost slot (and refunding when it is genuinely gone) belongs with the payment
 * webhook, not here.
 */
export async function confirmHold(
  db: Db,
  appointmentId: string,
): Promise<Appointment> {
  try {
    return await db.transaction(async (tx) => {
      // STEP 1 — clear expired holds from OTHER bookings that overlap this one.
      // Correlated against the target row so it is a single statement.
      await tx.execute(sql`
        DELETE FROM ${appointments} AS victim
         USING ${appointments} AS target
         WHERE target.id = ${appointmentId}
           AND victim.status = 'held'
           AND victim.hold_expires_at < now()
           AND victim.staff_id = target.staff_id
           AND victim.slot && target.slot
           AND victim.id <> target.id
      `);

      // STEP 2 — promote the hold. The constraint re-checks on update.
      const [appointment] = await tx
        .update(appointments)
        .set({ status: "confirmed", holdExpiresAt: null })
        .where(
          and(
            eq(appointments.id, appointmentId),
            eq(appointments.status, "held"),
          ),
        )
        .returning();

      if (!appointment) {
        throw new HoldNotFoundError(appointmentId);
      }

      return appointment;
    });
  } catch (error) {
    if (isExclusionViolation(error)) {
      const [row] = await db
        .select()
        .from(appointments)
        .where(eq(appointments.id, appointmentId))
        .limit(1);

      throw new SlotTakenError({
        staffId: row?.staffId ?? "unknown",
        serviceId: row?.serviceId ?? "unknown",
        startsAt: row?.startsAt ?? new Date(0),
        endsAt: row?.endsAt ?? new Date(0),
        slot: row?.slot ?? "",
      });
    }
    throw error;
  }
}

/* ===========================================================================
   Release and reclaim
   =========================================================================== */

/**
 * Give a held slot back immediately — the customer abandoned checkout, or the
 * Stripe session expired.
 *
 * Deletes rather than cancels: a hold that never became an appointment is not
 * history worth keeping, and deleting takes it out of the constraint's index
 * at once. Returns false if there was nothing held to release.
 */
export async function releaseHold(
  db: Db,
  appointmentId: string,
): Promise<boolean> {
  const released = await db
    .delete(appointments)
    .where(
      and(eq(appointments.id, appointmentId), eq(appointments.status, "held")),
    )
    .returning({ id: appointments.id });

  return released.length > 0;
}

/**
 * Release a hold on the strength of the customer's own token.
 *
 * The public picker is an unauthenticated endpoint, so `releaseHold` above —
 * which takes an id and asks no questions — must never be reachable from it.
 * An appointment id is a UUID and therefore unguessable in practice, but "in
 * practice" is not a security model: with only an id, anything that ever
 * leaked one (a log line, a shared screenshot, a Referer header) would hand
 * over the ability to cancel other people's slots.
 *
 * Returns false for a hold that is missing, already gone, or not theirs — all
 * three are the same answer to the caller, and distinguishing them out loud
 * would turn this into an oracle for which ids exist.
 */
export async function releaseHoldByToken(
  db: Db,
  appointmentId: string,
  manageToken: string,
): Promise<boolean> {
  return db.transaction((tx) =>
    deleteOwnHold(tx, appointmentId, manageToken),
  );
}

/**
 * A hold's live state, for a page that has to render a countdown against it.
 *
 * Returns null when the row is gone or is not theirs. `expiresAt` comes
 * straight off the row, so the client counts down against the DATABASE's
 * deadline rather than against a duration it was told once and has been
 * guessing from ever since.
 */
export async function readOwnHold(
  db: Db,
  appointmentId: string,
  manageToken: string,
): Promise<{
  id: string;
  startsAt: Date;
  endsAt: Date;
  staffId: string;
  serviceId: string;
  expiresAt: Date | null;
} | null> {
  const [row] = await db
    .select({
      id: appointments.id,
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      staffId: appointments.staffId,
      serviceId: appointments.serviceId,
      expiresAt: appointments.holdExpiresAt,
      manageTokenHash: appointments.manageTokenHash,
    })
    .from(appointments)
    .where(
      and(eq(appointments.id, appointmentId), eq(appointments.status, "held")),
    )
    .limit(1);

  if (!row || !manageTokenMatches(manageToken, row.manageTokenHash)) {
    return null;
  }

  // The hash never leaves this module; the caller gets the facts only.
  return {
    id: row.id,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    staffId: row.staffId,
    serviceId: row.serviceId,
    expiresAt: row.expiresAt,
  };
}

/**
 * The janitor. Deletes every hold whose deadline has passed.
 *
 * CORRECTNESS NEVER DEPENDS ON THIS RUNNING.
 *
 * If this function were deleted tomorrow and the nightly cron switched off,
 * the product would still never double-book and would still never show an
 * expired hold as unavailable, because:
 *   - every booking transaction deletes colliding expired holds before it
 *     writes (see `deleteCollidingExpiredHolds`), and
 *   - every availability query treats a hold past its deadline as free.
 *
 * All this does is keep dead rows from accumulating, so the constraint's index
 * stays small. It is housekeeping, not a safety mechanism — which is exactly
 * why a missed cron run is not an incident.
 *
 * Returns the number of rows reclaimed.
 */
export async function reclaimExpiredHolds(db: Db): Promise<number> {
  const reclaimed = await db
    .delete(appointments)
    .where(
      and(
        eq(appointments.status, "held"),
        sql`${appointments.holdExpiresAt} < now()`,
      ),
    )
    .returning({ id: appointments.id });

  return reclaimed.length;
}
