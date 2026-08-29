import "server-only";

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import { EXCLUSION_VIOLATION, findPostgresError } from "@/db/errors";
import {
  appointments,
  businesses,
  customers,
  notifications,
  services,
  type Appointment,
  type AppointmentStatus,
} from "@/db/schema";
import { depositCentsFor } from "@/lib/money";
import { deriveManageToken } from "@/lib/notifications/manage-link";
import { reminderInstantFor } from "@/lib/notifications/reminder";

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
 *   1. CLEAR expired holds that would collide — in the SAME transaction.
 *   2. INSERT or UPDATE, and let the constraint decide.
 *
 * Step 1 is mandatory and is not an optimisation. The constraint predicate
 * cannot reference now() (it must be IMMUTABLE), so an expired hold still
 * occupies its slot until a statement moves it out of 'held'. See the long
 * comment in drizzle/0002_appointments_no_overlap.sql, and the note on
 * REACHED_CHECKOUT below for why "clear" is sometimes a cancellation rather
 * than a delete.
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
   Ending a hold: delete it, or keep it as a cancellation
   =========================================================================== */

/**
 * WHY A HOLD IS SOMETIMES CANCELLED RATHER THAN DELETED.
 *
 * An ordinary hold that lapses is deleted. It never became anything, nobody
 * was ever told about it, and keeping it would only make the constraint's index
 * bigger — `releaseHold` says as much.
 *
 * A hold that reached a Stripe payment page is different, and the difference is
 * money. A payment may still be in flight for it: the customer can be on
 * Stripe's page at the exact moment their eight minutes run out, and the card
 * can go through a beat later. If that row had been deleted, the webhook would
 * arrive holding a payment for an appointment that no longer exists — nothing
 * to refund against, nothing to cancel, nobody to apologise to, and no way to
 * tell that case apart from a stray event.
 *
 * So a hold with a checkout session becomes `cancelled` instead. It costs
 * nothing: the exclusion constraint covers only 'held' and 'confirmed', so a
 * cancelled row blocks no slot and the time is genuinely back in the day. What
 * it buys is a row for the webhook to find — which is the whole of the
 * slot-lost path in src/server/payments/webhook.ts.
 */
const REACHED_CHECKOUT = sql`(
  ${appointments.stripeCheckoutSessionId} IS NOT NULL
  AND ${appointments.customerId} IS NOT NULL
)`;

/**
 * Reasons a hold ended, in the words the admin agenda and the apology email
 * both read. Constants rather than literals because the webhook MATCHES on
 * them to tell "this slot was swept out from under a payment" from "somebody
 * cancelled properly", and a typo in one of two copies would be silent.
 */
export const CANCELLATION_REASON = {
  /** The eight minutes ran out while the customer was on Stripe's page. */
  holdLapsedInCheckout: "The hold expired while checkout was open.",
  /** They pressed back on Stripe, or the session expired unpaid. */
  checkoutAbandoned: "Checkout was abandoned before payment.",
  /** Paid, but the time had already gone to somebody else. Refunded. */
  slotLostAfterPayment:
    "The deposit arrived after the slot had been taken by someone else. It was refunded in full.",
} as const;

/**
 * Cancel a lapsed hold, keeping the row. Only used where REACHED_CHECKOUT holds.
 *
 * The column names are written bare rather than through the Drizzle column
 * objects: those render as `"appointments"."status"`, and Postgres rejects a
 * qualified name on the left of a SET — "SET target columns cannot be qualified
 * with the relation name".
 */
function cancelLapsedHold(reason: string) {
  return sql`
    status = 'cancelled',
    hold_expires_at = NULL,
    cancelled_at = now(),
    cancelled_by = 'business',
    cancellation_reason = ${reason}
  `;
}

/* ===========================================================================
   Shared SQL
   =========================================================================== */

/**
 * Clear expired holds that would collide with `slot` for this staff member.
 *
 * This is the lazy half of hold expiry. It runs inside the caller's
 * transaction, immediately before the write it protects, so there is no window
 * in which another session could slip in between it and the insert — and if it
 * clears nothing, the constraint simply rejects the write, which is the correct
 * outcome.
 *
 * TWO STATEMENTS, ONE RULE. See the note on REACHED_CHECKOUT: a lapsed hold
 * that got as far as a payment page is cancelled so the webhook still has a row
 * to refund against; every other lapsed hold is deleted. Either way the slot
 * stops blocking, which is all the caller needs.
 *
 * `excludeAppointmentId` keeps a confirmation from sweeping away the very hold
 * it is trying to confirm.
 */
async function clearCollidingExpiredHolds(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  staffId: string,
  slot: string,
  excludeAppointmentId?: string,
) {
  const lapsed = sql`
    ${appointments.status} = 'held'
    AND ${appointments.holdExpiresAt} < now()
    AND ${appointments.staffId} = ${staffId}
    AND ${appointments.slot} && ${slot}::tstzrange
    ${
      excludeAppointmentId
        ? sql`AND ${appointments.id} <> ${excludeAppointmentId}`
        : sql``
    }
  `;

  await tx.execute(sql`
    UPDATE ${appointments}
       SET ${cancelLapsedHold(CANCELLATION_REASON.holdLapsedInCheckout)}
     WHERE ${lapsed} AND ${REACHED_CHECKOUT}
  `);

  await tx.execute(sql`
    DELETE FROM ${appointments}
     WHERE ${lapsed} AND NOT ${REACHED_CHECKOUT}
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

  /* The calendar identity comes first, because the manage token is DERIVED
     from it — see src/lib/notifications/manage-link.ts. That is what lets the
     outbox worker rebuild the customer's link days later without the plaintext
     ever being stored, and what makes the token in the hold cookie and the
     token in the confirmation email the same string. */
  const icsUid = `${randomUUID()}@${ICS_UID_DOMAIN}`;
  const manageToken = deriveManageToken(icsUid);
  const manageTokenHash = hashManageToken(manageToken);

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
        await endOwnHold(tx, previous.appointmentId, previous.manageToken);
      }

      // STEP 1 — clear expired holds that would otherwise block us.
      await clearCollidingExpiredHolds(tx, input.staffId, range.slot);

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
          /* The deposit is SNAPSHOTTED here, from the one implementation in
             src/lib/money.ts. Charging what the service asked for at the
             moment the slot was taken is what stops an owner editing prices
             mid-form from changing what this customer is about to pay. */
          depositCents: depositCentsFor(service),
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
async function endOwnHold(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  appointmentId: string,
  manageToken: string,
): Promise<boolean> {
  const [row] = await tx
    .select({
      id: appointments.id,
      manageTokenHash: appointments.manageTokenHash,
      /* Which of the two endings this is. See REACHED_CHECKOUT. */
      reachedCheckout: sql<boolean>`(
        ${appointments.stripeCheckoutSessionId} IS NOT NULL
        AND ${appointments.customerId} IS NOT NULL
      )`,
    })
    .from(appointments)
    .where(
      and(eq(appointments.id, appointmentId), eq(appointments.status, "held")),
    )
    .limit(1);

  if (!row || !manageTokenMatches(manageToken, row.manageTokenHash)) {
    return false;
  }

  const mine = and(
    eq(appointments.id, appointmentId),
    eq(appointments.status, "held"),
  );

  /* A hold that reached a payment page keeps its row — a payment may still be
     in flight for it and the webhook has to have something to refund against.
     Cancelled blocks nothing, so the slot comes back either way. */
  const ended = row.reachedCheckout
    ? await tx
        .update(appointments)
        .set({
          status: "cancelled",
          holdExpiresAt: null,
          cancelledAt: new Date(),
          cancelledBy: "business",
          cancellationReason: CANCELLATION_REASON.checkoutAbandoned,
        })
        .where(mine)
        .returning({ id: appointments.id })
    : await tx.delete(appointments).where(mine).returning({ id: appointments.id });

  return ended.length > 0;
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

/* ===========================================================================
   Confirm a hold — the transaction the whole payment path exists for
   =========================================================================== */

/*
 * How far ahead of the appointment a reminder goes out is `businesses
 * .reminder_lead_min`, read inside the transaction that writes the row. It
 * used to be a constant here; it is a setting because the right answer differs
 * by trade, and the arithmetic — including the case where there is no reminder
 * to give — lives in one place: `reminderInstantFor` in
 * src/lib/notifications/reminder.ts.
 */

export type ConfirmPaidHoldResult =
  /** The slot was still ours. Booked, and the outbox rows are written. */
  | { outcome: "confirmed"; appointment: Appointment }
  /**
   * Already booked. A REPLAY, and the correct answer to one: Stripe retries,
   * and an event delivered twice must produce one appointment and one set of
   * outbox rows. Nothing is written here.
   */
  | { outcome: "already-confirmed"; appointment: Appointment }
  /**
   * THE HARD CASE. The hold lapsed and the slot went to somebody else before
   * this payment reached us. The row survives as a cancellation precisely so
   * this can be reported rather than guessed at — see REACHED_CHECKOUT. The
   * caller refunds, apologises, and offers other times.
   */
  | { outcome: "slot-lost"; appointment: Appointment }
  /** No such appointment. A poison event: log it and stop retrying. */
  | { outcome: "not-found" };

/**
 * Turn a paid hold into a confirmed appointment — in ONE transaction.
 *
 * CALLED ONLY FROM THE VERIFIED STRIPE WEBHOOK. The success redirect is a
 * browser navigation and proves nothing; this is the only function in the
 * codebase that may flip an appointment to `confirmed` after a payment, and it
 * runs behind a signature check.
 *
 * Everything below happens together or not at all: re-acquiring the slot,
 * promoting the row, recording the payment, filling in the calendar identity,
 * and QUEUEING the messages. That last one is why the transaction has to cover
 * all of it — a confirmed appointment nobody is ever told about is worse than
 * a failed booking, and writing the outbox rows in the same transaction makes
 * that state unrepresentable.
 *
 * NOTE ON EXPIRED-BUT-PRESENT HOLDS: a hold whose deadline has passed but whose
 * row is still `held` is still ours. Nothing released it, the constraint kept
 * the slot reserved the whole time, and confirming it is correct rather than an
 * error. The slot is only genuinely lost when something moved the row out of
 * `held`, which is what `outcome: "slot-lost"` reports.
 */
export async function confirmPaidHold(
  db: Db,
  input: {
    appointmentId: string;
    /** Stripe's PaymentIntent, recorded so a later refund can be matched. */
    paymentIntentId?: string | null;
    /** One clock for the whole transaction. */
    now?: Date;
  },
): Promise<ConfirmPaidHoldResult> {
  const now = input.now ?? new Date();

  try {
    return await db.transaction(async (tx) => {
      /**
       * FOR UPDATE, and it is not decoration.
       *
       * Two deliveries of the same event can arrive concurrently — Stripe
       * retries on timeout, and the first attempt may still be running. The
       * row lock makes the second one wait and then read `confirmed`, so it
       * returns a replay instead of queueing a second confirmation email.
       */
      const [held] = await tx
        .select()
        .from(appointments)
        .where(eq(appointments.id, input.appointmentId))
        .limit(1)
        .for("update");

      if (!held) {
        return { outcome: "not-found" as const };
      }

      if (held.status === "confirmed") {
        return { outcome: "already-confirmed" as const, appointment: held };
      }

      if (held.status !== "held" || held.customerId === null) {
        /* Cancelled by the sweep while the payment was in flight, or in some
           other state entirely. Either way this booking is not happening and
           the caller owes the customer their money back. */
        return { outcome: "slot-lost" as const, appointment: held };
      }

      /* Only ever different from `held.icsUid` for a row that arrived without
         one at all — see the note on the update below. */
      const repairedIcsUid = held.icsUid || `${randomUUID()}@${ICS_UID_DOMAIN}`;

      /* STEP 1 — clear lapsed holds from OTHER bookings overlapping this one,
         so a neighbour that expired cannot make the promotion fail. */
      await clearCollidingExpiredHolds(tx, held.staffId, held.slot, held.id);

      /* STEP 2 — promote it. `WHERE status = 'held'` is the second half of the
         lock: if anything moved the row between the read and here, zero rows
         update and the whole transaction rolls back rather than half-booking. */
      const [appointment] = await tx
        .update(appointments)
        .set({
          status: "confirmed",
          holdExpiresAt: null,
          stripePaymentIntentId: input.paymentIntentId ?? null,
          /**
           * The calendar identity, filled in only when it is missing.
           *
           * `ics_uid` is STABLE FOR THE APPOINTMENT'S WHOLE LIFE — a reschedule
           * reuses it and bumps the sequence, which is how a calendar client
           * knows to update the existing event instead of adding a second one.
           * Regenerating it here would leave a stale duplicate in somebody's
           * calendar forever, so a hold that already has one keeps it and only
           * an appointment created without one gets a new one.
           */
          icsUid: repairedIcsUid,
          /**
           * Same for the manage token, and for the same reason — it is DERIVED
           * from the UID above, so repairing one without the other would leave
           * a row whose stored hash no manage link could ever satisfy. A row
           * that already has both keeps both; this branch only covers one that
           * somehow arrived without them.
           */
          manageTokenHash:
            held.manageTokenHash || hashManageToken(deriveManageToken(repairedIcsUid)),
        })
        .where(
          and(
            eq(appointments.id, input.appointmentId),
            eq(appointments.status, "held"),
          ),
        )
        .returning();

      if (!appointment) {
        throw new HoldNotFoundError(input.appointmentId);
      }

      /**
       * STEP 3 — THE OUTBOX. Rows, not sends.
       *
       * Nothing is emailed here. The webhook has to be fast and idempotent,
       * and neither survives an HTTP call to an email provider inside it: a
       * slow Resend would push Stripe past its timeout and earn a retry that
       * then has to be recognised as a duplicate, and a send that failed inside
       * the transaction would roll back a payment already taken.
       *
       * So the intent is written down and a worker delivers it. A provider
       * outage becomes a pending row to retry and a visible state in the admin
       * area, rather than a confirmation that silently never arrived — which,
       * in a booking product, is the difference between a working business and
       * an angry phone call.
       */
      /* BOTH ADDRESSES IN ONE ROUND TRIP. Two selects would be two more
         network hops inside a transaction the Stripe webhook is waiting on,
         and the second one is Stripe's timeout. */
      const [contact] = await tx
        .select({
          customerEmail: customers.email,
          businessEmail: businesses.contactEmail,
          reminderLeadMin: businesses.reminderLeadMin,
        })
        .from(customers)
        .innerJoin(businesses, eq(businesses.id, appointment.businessId))
        .where(eq(customers.id, appointment.customerId!))
        .limit(1);

      if (contact) {
        const reminderAt = reminderInstantFor({
          startsAt: appointment.startsAt,
          reminderLeadMin: contact.reminderLeadMin,
          now,
        });

        await tx.insert(notifications).values([
          {
            appointmentId: appointment.id,
            kind: "confirmation",
            channel: "email",
            toEmail: contact.customerEmail,
            scheduledFor: now,
          },
          /* NULL means a booking made inside the reminder window: the
             appointment is sooner than the reminder would be, and queueing one
             for a moment already past would send it immediately, a minute
             after the confirmation, reading as a duplicate. */
          ...(reminderAt
            ? [
                {
                  appointmentId: appointment.id,
                  kind: "reminder" as const,
                  channel: "email" as const,
                  toEmail: contact.customerEmail,
                  scheduledFor: reminderAt,
                },
              ]
            : []),
          /* And the OWNER's copy, in the same transaction as the customer's.
             A business that only learns about a booking when somebody walks in
             is a business that will eventually double-book its own diary by
             hand. Different audience, different words — see the templates. */
          {
            appointmentId: appointment.id,
            kind: "new_booking" as const,
            channel: "email" as const,
            toEmail: contact.businessEmail,
            scheduledFor: now,
          },
        ]);
      }

      return { outcome: "confirmed" as const, appointment };
    });
  } catch (error) {
    /**
     * The constraint refused the promotion.
     *
     * Vanishingly unlikely — this row is already in the constraint's index
     * with this exact range, so nothing overlapping it can exist — but if it
     * ever happens the answer is the same as any other lost slot, and the
     * caller's refund path handles it.
     */
    if (isExclusionViolation(error)) {
      const [row] = await db
        .select()
        .from(appointments)
        .where(eq(appointments.id, input.appointmentId))
        .limit(1);

      return row
        ? { outcome: "slot-lost", appointment: row }
        : { outcome: "not-found" };
    }

    throw error;
  }
}

/* ===========================================================================
   Release and reclaim
   =========================================================================== */

/**
 * Give a held slot back immediately — the customer abandoned checkout, or the
 * Stripe session expired unpaid.
 *
 * A thin name over `abandonHold`, kept because "release this hold" is what the
 * callers mean and the two-ending rule is an implementation detail of it.
 */
export async function releaseHold(
  db: Db,
  appointmentId: string,
): Promise<boolean> {
  return abandonHold(db, appointmentId, CANCELLATION_REASON.checkoutAbandoned);
}

/**
 * End a hold by id, whatever it takes, and give the slot back.
 *
 * The one entry point for "this hold is over and nobody paid": the customer
 * left, or Stripe told us the session expired unpaid. Deletes an ordinary
 * hold and CANCELS one that reached a payment page — see REACHED_CHECKOUT for
 * why that distinction is worth a second statement.
 *
 * Returns false if there was nothing held to end, which is not an error: it is
 * what a replayed `checkout.session.expired` looks like, and what a hold that
 * already lapsed and was swept looks like.
 */
export async function abandonHold(
  db: Db,
  appointmentId: string,
  reason: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const mine = and(
      eq(appointments.id, appointmentId),
      eq(appointments.status, "held"),
    );

    const cancelled = await tx
      .update(appointments)
      .set({
        status: "cancelled",
        holdExpiresAt: null,
        cancelledAt: new Date(),
        cancelledBy: "business",
        cancellationReason: reason,
      })
      .where(and(mine, sql`${REACHED_CHECKOUT}`))
      .returning({ id: appointments.id });

    if (cancelled.length > 0) {
      return true;
    }

    const deleted = await tx
      .delete(appointments)
      .where(mine)
      .returning({ id: appointments.id });

    return deleted.length > 0;
  });
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
    endOwnHold(tx, appointmentId, manageToken),
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
  /** Snapshotted when the hold was written. The authority on what is owed. */
  priceCents: number;
  depositCents: number;
} | null> {
  const [row] = await db
    .select({
      id: appointments.id,
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      staffId: appointments.staffId,
      serviceId: appointments.serviceId,
      expiresAt: appointments.holdExpiresAt,
      priceCents: appointments.priceCents,
      depositCents: appointments.depositCents,
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
    priceCents: row.priceCents,
    depositCents: row.depositCents,
  };
}

/* ===========================================================================
   Claim a hold — attach the customer, and confirm it if nothing is owed
   =========================================================================== */

export interface ClaimHoldInput {
  appointmentId: string;
  /** Proof the hold is this browser's. Checked in constant time. */
  manageToken: string;
  businessId: string;
  customer: {
    name: string;
    email: string;
    phone: string | null;
    /**
     * The IANA zone their browser reported, or null if it would not say.
     *
     * Recorded so a confirmation can print a second, labelled time for
     * somebody booking from another country. NOTHING IS SCHEDULED IN IT — see
     * the column comment in src/db/schema.ts.
     *
     * OPTIONAL, because absent is a real and ordinary answer: a booking the
     * owner types in at the counter has no browser to ask, and a browser that
     * declines to say leaves it null too. Both mean the same thing to every
     * template — print one time instead of two.
     */
    timeZone?: string | null;
  };
  customerNote: string | null;
  /** When the cancellation policy was ticked. */
  policyAcceptedAt: Date;
  /**
   * True when the deposit is zero and there is nothing to pay.
   *
   * A FREE CONSULTATION IS CONFIRMED HERE AND NOW. Sending somebody to a
   * payment page for nought pounds, or worse leaving them holding a slot that
   * expires while they wait for a step that has nothing to do, is how a
   * perfectly good business gets treated as an edge case. The whole booking
   * finishes in this transaction.
   */
  confirmNow: boolean;
}

export type ClaimHoldResult =
  | { ok: true; appointment: Appointment; customerId: string }
  /** The hold was swept or released between the checks and the write. */
  | { ok: false; reason: "hold-gone" };

/**
 * Put a name to a hold, and finish the booking if there is nothing to pay.
 *
 * ONE TRANSACTION, THREE WRITES. The customer is found or created, the
 * appointment is claimed, and — when nothing is owed — the outbox rows are
 * written: the customer's confirmation and reminder, and the owner's copy.
 * Either all three land or none do, which is what stops the two failure modes
 * that matter: a confirmed appointment nobody is ever told about, and a
 * customer row created for a booking that never happened.
 *
 * The emails are NOT sent here. They are rows in `notifications` that a worker
 * picks up, so a Resend outage cannot roll back a confirmed appointment.
 */
export async function claimHold(
  db: Db,
  input: ClaimHoldInput,
): Promise<ClaimHoldResult> {
  return db.transaction(async (tx) => {
    /* The hold has to still be ours. Read first because the token comparison
       is constant-time in Node rather than a SQL equality — see
       `manageTokenMatches`.

       The business's contact address is joined on here rather than fetched
       later, because the owner's copy of the booking is written a few
       statements below and a second SELECT would be another network round trip
       inside a transaction the customer is watching a countdown against. */
    const [held] = await tx
      .select({
        id: appointments.id,
        manageTokenHash: appointments.manageTokenHash,
        businessEmail: businesses.contactEmail,
        reminderLeadMin: businesses.reminderLeadMin,
      })
      .from(appointments)
      .innerJoin(businesses, eq(businesses.id, appointments.businessId))
      .where(
        and(
          eq(appointments.id, input.appointmentId),
          eq(appointments.status, "held"),
        ),
      )
      .limit(1);

    if (!held || !manageTokenMatches(input.manageToken, held.manageTokenHash)) {
      return { ok: false, reason: "hold-gone" as const };
    }

    /**
     * FIND OR CREATE, NEVER DUPLICATE.
     *
     * `customers` is unique on (business_id, email), and this leans on that
     * index rather than on a SELECT followed by an INSERT — which is the same
     * race as checking a slot before booking it, and loses the same way under
     * two concurrent submits from the same person. The database arbitrates.
     *
     * The name always takes the new value: they just typed it, and a person
     * who married since their last haircut is right and the old row is wrong.
     * The phone only overwrites when one was given, so leaving the optional
     * field blank does not quietly delete the number they gave last time.
     */
    const [customer] = await tx
      .insert(customers)
      .values({
        businessId: input.businessId,
        name: input.customer.name,
        email: input.customer.email,
        phone: input.customer.phone,
        timezone: input.customer.timeZone ?? null,
      })
      .onConflictDoUpdate({
        target: [customers.businessId, customers.email],
        set: {
          name: sql`excluded.name`,
          phone: sql`coalesce(excluded.phone, ${customers.phone})`,
          /* Same rule as the phone, for the same reason: a booking made from a
             browser that would not name its zone must not erase the zone a
             previous booking did give us. */
          timezone: sql`coalesce(excluded.timezone, ${customers.timezone})`,
        },
      })
      .returning({ id: customers.id });

    /**
     * Claim it.
     *
     * `WHERE status = 'held'` is the second half of the check above: if
     * anything swept the row between the two statements, zero rows update and
     * the whole transaction rolls back rather than half-claiming a booking.
     *
     * No sweep of colliding expired holds is needed here, unlike every INSERT
     * in this module. The row's range is not changing, and it is already in
     * the constraint's index — nothing overlapping it can exist, or it could
     * not have been inserted in the first place.
     */
    const [appointment] = await tx
      .update(appointments)
      .set({
        customerId: customer.id,
        customerNote: input.customerNote,
        policyAcceptedAt: input.policyAcceptedAt,
        ...(input.confirmNow
          ? { status: "confirmed" as const, holdExpiresAt: null }
          : {}),
      })
      .where(
        and(
          eq(appointments.id, input.appointmentId),
          eq(appointments.status, "held"),
        ),
      )
      .returning();

    if (!appointment) {
      return { ok: false, reason: "hold-gone" as const };
    }

    if (input.confirmNow) {
      /* The outbox. Due immediately; a worker sends it. Writing it inside the
         transaction is what guarantees a confirmed appointment always has a
         confirmation queued against it.

         THE SAME THREE ROWS THE PAID PATH WRITES. A booking with no deposit is
         still a booking: the customer gets a confirmation and a reminder, and
         the owner hears about it. See the matching block in `confirmPaidHold`
         — the two paths differ in what confirms the appointment, never in what
         the people involved are told. */
      const now = new Date();
      const reminderAt = reminderInstantFor({
        startsAt: appointment.startsAt,
        reminderLeadMin: held.reminderLeadMin,
        now,
      });

      await tx.insert(notifications).values([
        {
          appointmentId: appointment.id,
          kind: "confirmation" as const,
          channel: "email" as const,
          toEmail: input.customer.email,
          scheduledFor: now,
        },
        /* Nothing to remind anybody about when the appointment is sooner than
           the reminder would be. */
        ...(reminderAt
          ? [
              {
                appointmentId: appointment.id,
                kind: "reminder" as const,
                channel: "email" as const,
                toEmail: input.customer.email,
                scheduledFor: reminderAt,
              },
            ]
          : []),
        {
          appointmentId: appointment.id,
          kind: "new_booking" as const,
          channel: "email" as const,
          toEmail: held.businessEmail,
          scheduledFor: now,
        },
      ]);
    }

    return { ok: true, appointment, customerId: customer.id };
  });
}

/**
 * One appointment, whatever its status, if the token proves it is theirs.
 *
 * `readOwnHold` deliberately matches only `held`, because everything the
 * picker does is about a live hold. This is the other question — "show me the
 * booking I just made" — and it has to see a `confirmed` row. Same token, same
 * constant-time comparison; the only difference is which statuses count.
 */
export async function readOwnAppointment(
  db: Db,
  appointmentId: string,
  manageToken: string,
): Promise<Appointment | null> {
  const [row] = await db
    .select()
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .limit(1);

  if (!row || !manageTokenMatches(manageToken, row.manageTokenHash)) {
    return null;
  }

  return row;
}

/* ===========================================================================
   The customer moves their own appointment
   =========================================================================== */

export interface MoveAppointmentInput {
  appointmentId: string;
  /** The customer's new start. The end is recomputed from the service. */
  startsAt: Date | string;
}

export type MoveAppointmentResult =
  /** Moved. `previous` is what it was, for the email that has to say both. */
  | {
      outcome: "moved";
      appointment: Appointment;
      previous: { startsAt: Date; endsAt: Date };
    }
  /** Somebody else has the new time. The appointment is UNTOUCHED. */
  | { outcome: "slot-taken" }
  /** Not a live booking any more — cancelled, completed, or never confirmed. */
  | { outcome: "not-movable"; status: AppointmentStatus | null }
  /** Already sitting on exactly that instant. A double submit; nothing to do. */
  | { outcome: "unchanged"; appointment: Appointment };

/**
 * Move a confirmed appointment to a new time — IN ONE TRANSACTION, AND WITHOUT
 * EVER LETTING GO OF THE OLD SLOT FIRST.
 *
 * ═══ WHY THIS IS AN UPDATE AND NOT A RELEASE-THEN-BOOK ═══
 *
 * The obvious shape — cancel the old appointment, then book the new time — has
 * a failure mode that is unacceptable in a booking product: if the second half
 * loses a race, the customer is left with NO appointment at all, having asked
 * only to move one. No amount of retrying fixes that, because by then their
 * original slot may be gone too.
 *
 * So the row is never released. One UPDATE rewrites `slot`, `starts_at` and
 * `ends_at` in place, and the exclusion constraint arbitrates the new range
 * exactly as it arbitrates an insert. Because it is the SAME ROW, the old
 * range stops blocking and the new one starts blocking in a single atomic
 * statement — and the constraint does not compare a row against itself, so a
 * move that overlaps the appointment's own old span is legal, which "release
 * then re-book" could not express at all.
 *
 * If the new range collides, Postgres raises 23P01, the transaction rolls back,
 * and THE APPOINTMENT IS EXACTLY WHERE IT WAS. That is the whole guarantee: the
 * customer either has the new time or still has the old one, never neither.
 *
 * ═══ WHAT ELSE MOVES WITH IT ═══
 *
 * `ics_sequence` is incremented, because the invite that goes out has to be
 * NEWER than the one already in the customer's calendar or every client will
 * correctly ignore it. The UID is untouched — same appointment, same event,
 * moved. See src/lib/notifications/invite.ts.
 *
 * The money does not move. `price_cents` and `deposit_cents` are snapshots from
 * booking time and the deposit is already paid against this row; a reschedule
 * is not a new sale, and re-pricing somebody who moved a haircut by an hour
 * would be indefensible.
 *
 * Nothing is emailed here. The caller writes the outbox rows.
 */
export async function moveAppointment(
  db: Db,
  input: MoveAppointmentInput,
): Promise<MoveAppointmentResult> {
  const startsAt =
    typeof input.startsAt === "string"
      ? new Date(input.startsAt)
      : input.startsAt;

  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(appointments)
        .where(eq(appointments.id, input.appointmentId))
        .limit(1);

      if (!current || current.status !== "confirmed") {
        return {
          outcome: "not-movable" as const,
          status: current?.status ?? null,
        };
      }

      /**
       * IDEMPOTENCY, and it is not optional.
       *
       * A double-submitted move must not bump `ics_sequence` twice and send a
       * second invite for a time nothing changed about. Comparing the instant
       * is exact — both sides are `timestamptz` — so "already there" is a fact
       * rather than a guess.
       */
      if (current.startsAt.getTime() === startsAt.getTime()) {
        return { outcome: "unchanged" as const, appointment: current };
      }

      /* The service is read INSIDE the transaction, so the buffers written
         into the new range are the ones the database currently holds. */
      const [service] = await tx
        .select()
        .from(services)
        .where(eq(services.id, current.serviceId))
        .limit(1);

      if (!service) {
        throw new ServiceNotFoundError(current.serviceId);
      }

      const range = buildBlockingRange(startsAt, service);

      /* Mandatory, exactly as on every other write in this module: an expired
         hold still occupies its slot until a statement moves it, because the
         constraint predicate cannot reference now(). */
      await clearCollidingExpiredHolds(
        tx,
        current.staffId,
        range.slot,
        current.id,
      );

      const [moved] = await tx
        .update(appointments)
        .set({
          slot: range.slot,
          startsAt: range.startsAt,
          endsAt: range.endsAt,
          /* NEWER THAN THE INVITE ALREADY IN THEIR CALENDAR, or the client
             ignores it and the customer arrives at the old time. */
          icsSequence: sql`${appointments.icsSequence} + 1`,
        })
        .where(
          and(
            eq(appointments.id, input.appointmentId),
            /* The second half of the read above: if anything moved this row
               between the two statements, zero rows update and the whole
               transaction rolls back rather than half-moving a booking. */
            eq(appointments.status, "confirmed"),
          ),
        )
        .returning();

      if (!moved) {
        return { outcome: "not-movable" as const, status: current.status };
      }

      return {
        outcome: "moved" as const,
        appointment: moved,
        previous: { startsAt: current.startsAt, endsAt: current.endsAt },
      };
    });
  } catch (error) {
    if (isExclusionViolation(error)) {
      /* Somebody took the new time first. The transaction rolled back, so the
         customer still has the appointment they started with. */
      return { outcome: "slot-taken" as const };
    }

    throw error;
  }
}

/* ===========================================================================
   The customer cancels their own appointment
   =========================================================================== */

export type CancelAppointmentResult =
  /** Cancelled by this call. The slot is free from the moment it commits. */
  | { outcome: "cancelled"; appointment: Appointment }
  /**
   * ALREADY CANCELLED, and this is the answer a double-click gets.
   *
   * Not an error: the customer asked for this appointment to be cancelled and
   * it is cancelled. The caller treats it as success and — critically — does
   * NOT refund again.
   */
  | { outcome: "already-cancelled"; appointment: Appointment }
  /** Completed, no-show, or never confirmed. Nothing to cancel. */
  | { outcome: "not-cancellable"; status: AppointmentStatus | null };

/**
 * Cancel a confirmed appointment, freeing the slot immediately.
 *
 * ═══ IDEMPOTENT BY CONSTRUCTION, BECAUSE MONEY DEPENDS ON IT ═══
 *
 * The UPDATE matches `WHERE status = 'confirmed'`. Two concurrent
 * cancellations — a double-clicked button, a customer on two devices — both
 * try it; exactly one updates a row and gets `cancelled`, and the other
 * updates nothing and gets `already-cancelled`. The refund hangs off the FIRST
 * answer only, so "double-clicking Cancel must not attempt two refunds" is a
 * property of the statement rather than of a flag somebody has to remember to
 * check.
 *
 * The slot is freed the instant this commits: the exclusion constraint covers
 * only `held` and `confirmed`, so a cancelled row blocks nothing and the time
 * is genuinely back in the day with no sweep required.
 *
 * `ics_sequence` is incremented for the same reason a move increments it — the
 * METHOD:CANCEL going out has to outrank the invite already in the calendar.
 *
 * NOTHING IS REFUNDED AND NOTHING IS EMAILED HERE. Both are the caller's,
 * because both are network calls that must not sit inside a transaction.
 */
export async function cancelAppointment(
  db: Db,
  input: {
    appointmentId: string;
    cancelledBy: "customer" | "business";
    reason: string | null;
  },
): Promise<CancelAppointmentResult> {
  return db.transaction(async (tx) => {
    const [cancelled] = await tx
      .update(appointments)
      .set({
        status: "cancelled",
        holdExpiresAt: null,
        cancelledAt: new Date(),
        cancelledBy: input.cancelledBy,
        cancellationReason: input.reason,
        icsSequence: sql`${appointments.icsSequence} + 1`,
      })
      .where(
        and(
          eq(appointments.id, input.appointmentId),
          /* THE GUARD. Exactly one concurrent caller can match this. */
          eq(appointments.status, "confirmed"),
        ),
      )
      .returning();

    if (cancelled) {
      return { outcome: "cancelled" as const, appointment: cancelled };
    }

    /* Nothing updated. Find out whether that is because it was already
       cancelled — the ordinary double-click — or because it was never
       cancellable at all. */
    const [current] = await tx
      .select()
      .from(appointments)
      .where(eq(appointments.id, input.appointmentId))
      .limit(1);

    if (current?.status === "cancelled") {
      return { outcome: "already-cancelled" as const, appointment: current };
    }

    return {
      outcome: "not-cancellable" as const,
      status: current?.status ?? null,
    };
  });
}

/**
 * The janitor. Clears every hold whose deadline has passed.
 *
 * CORRECTNESS NEVER DEPENDS ON THIS RUNNING.
 *
 * If this function were deleted tomorrow and the nightly cron switched off,
 * the product would still never double-book and would still never show an
 * expired hold as unavailable, because:
 *   - every booking transaction clears colliding expired holds before it
 *     writes (see `clearCollidingExpiredHolds`), and
 *   - every availability query treats a hold past its deadline as free.
 *
 * All this does is keep dead rows from accumulating, so the constraint's index
 * stays small. It is housekeeping, not a safety mechanism — which is exactly
 * why a missed cron run is not an incident.
 *
 * Returns the number of rows reclaimed.
 */
export async function reclaimExpiredHolds(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    const lapsed = sql`
      ${appointments.status} = 'held'
      AND ${appointments.holdExpiresAt} < now()
    `;

    /* Same rule as everywhere else: a hold that reached a payment page keeps
       its row as a cancellation, because a payment may still be in flight for
       it. Everything else goes. See REACHED_CHECKOUT. */
    const cancelled = await tx.execute(sql`
      UPDATE ${appointments}
         SET ${cancelLapsedHold(CANCELLATION_REASON.holdLapsedInCheckout)}
       WHERE ${lapsed} AND ${REACHED_CHECKOUT}
    `);

    const deleted = await tx.execute(sql`
      DELETE FROM ${appointments}
       WHERE ${lapsed} AND NOT ${REACHED_CHECKOUT}
    `);

    return (cancelled.rowCount ?? 0) + (deleted.rowCount ?? 0);
  });
}
