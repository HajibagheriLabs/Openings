import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import type { Db } from "@/db/client";
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

/** SQLSTATE 23P01. */
const EXCLUSION_VIOLATION = "23P01";

/**
 * Postgres errors arrive wrapped by the driver and sometimes re-wrapped by
 * Drizzle, so the code can sit a couple of links down the `cause` chain.
 * Matching on SQLSTATE rather than on a message keeps this locale-proof.
 */
function isExclusionViolation(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; current && depth < 5; depth += 1) {
    if (
      typeof current === "object" &&
      "code" in current &&
      (current as { code?: unknown }).code === EXCLUSION_VIOLATION
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return false;
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
  customerId: string;
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
  const holdMinutes = input.holdMinutes ?? DEFAULT_HOLD_MINUTES;

  const manageToken = randomBytes(32).toString("base64url");
  const manageTokenHash = createHash("sha256").update(manageToken).digest("hex");
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

      // STEP 1 — clear expired holds that would otherwise block us.
      await deleteCollidingExpiredHolds(tx, input.staffId, range.slot);

      // STEP 2 — write, and let the constraint arbitrate.
      const [appointment] = await tx
        .insert(appointments)
        .values({
          businessId: input.businessId,
          staffId: input.staffId,
          serviceId: input.serviceId,
          customerId: input.customerId,
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
