"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { appointments, notifications, staff, timeOff } from "@/db/schema";
import type { AppointmentDetail } from "@/lib/admin/calendar";
import {
  cancelScheduledDeliveries,
  dispatchDeliveries,
} from "@/lib/notifications/delivery";
import { CHECKOUT_METADATA, OWNER_TAG } from "@/lib/payments/checkout";
import { getStripe } from "@/lib/payments/stripe";
import {
  cancelAppointment,
  createManualAppointment,
  setInternalNote,
  settleAppointment,
} from "@/lib/scheduling/booking";
import { loadDayView, nearestOffers } from "@/lib/scheduling/day-view";
import { localDateOf } from "@/lib/scheduling/local-minutes";
import { toTstzRangeLiteral } from "@/lib/scheduling/slot";
import { AMBIGUOUS_TIME_NOTE, resolveWallClock } from "@/lib/scheduling/wall-clock";
import {
  blockTimeSchema,
  cancelAppointmentSchema,
  internalNoteSchema,
  manualBookingSchema,
  settleAppointmentSchema,
  type BlockTimeInput,
  type ManualBookingInput,
} from "@/lib/validation/agenda";
import { findConflictingAppointments } from "@/server/queries/hours";
import { loadAppointmentDetail } from "@/server/queries/agenda";

import { requireOwnerBusiness } from "./context";
import type { FieldErrors, MutationResult } from "./result";

/**
 * Everything the master schedule can write.
 *
 * EVERY ACTION DERIVES THE BUSINESS FROM THE SESSION. None of them takes a
 * `businessId` argument, because a Server Action is a public HTTP endpoint and
 * one that accepted a tenant id would be a forged request away from letting
 * anybody cancel somebody else's appointments. Every row touched below is still
 * matched on `business_id` in its WHERE clause, so a stolen appointment id from
 * another tenant updates zero rows rather than the wrong one.
 */

function revalidateCalendar(): void {
  revalidatePath("/admin/calendar");
  revalidatePath("/admin");
  revalidatePath("/admin/customers");
}

/* ===========================================================================
   MANUAL BOOKING — a phone call, or somebody standing at the counter
   =========================================================================== */

export type ManualBookingField =
  | "serviceId"
  | "staffId"
  | "date"
  | "startLocal"
  | "customerName"
  | "customerEmail"
  | "customerPhone";

export type ManualBookingResult =
  | {
      ok: true;
      message: string;
      appointmentId: string;
      /** Set when the local time was ambiguous. See AMBIGUOUS_TIME_NOTE. */
      note?: string;
    }
  | {
      ok: false;
      message: string;
      fieldErrors?: FieldErrors<ManualBookingField>;
      /**
       * The times that ARE on offer near the one that was refused.
       *
       * Only ever set for the policy refusal, never for the overlap: an owner
       * whose 14:00 is outside opening hours may well want the 14:15 that is
       * inside them, and an owner whose 14:00 is already taken needs a
       * different answer, not a nearby one.
       */
      nearest?: { startsAt: string; endsAt: string }[];
      /** True when only the override toggle stands between them and this. */
      overridable?: boolean;
    };

/**
 * Write an appointment directly.
 *
 * ═══ THE OVERRIDE, AND THE ONE THING IT CANNOT DO ═══
 *
 * `override: false` — the default — runs the booking through THE SAME
 * availability engine a customer goes through: opening hours, closures,
 * minimum lead time, the booking horizon, and whether that staff member is
 * assigned to that service. If the time is not being offered, the booking is
 * refused and the nearest real openings come back with the refusal.
 *
 * `override: true` skips ALL OF THAT, deliberately. An owner working late on a
 * Tuesday, squeezing somebody in twenty minutes from now, or booking four
 * months out is not doing anything wrong — those rules exist to stop a stranger
 * booking something the business cannot honour, and the business is not a
 * stranger. Refusing them would leave the owner with a diary that disagrees
 * with reality and no way to fix it.
 *
 * WHAT NEITHER SETTING TOUCHES IS THE OVERLAP. The insert goes through the same
 * `appointments_no_overlap` exclusion constraint as every other booking in the
 * product, and there is no code path in this file or in
 * src/lib/scheduling/booking.ts that turns it off. One person cannot be in two
 * chairs at once; that is not a policy an owner may override, it is arithmetic.
 * The form says this in as many words next to the toggle.
 */
export async function createManualBooking(
  input: ManualBookingInput,
): Promise<ManualBookingResult> {
  const business = await requireOwnerBusiness();

  const parsed = manualBookingSchema.safeParse(input);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];

    return {
      ok: false,
      message: issue.message,
      fieldErrors: {
        [issue.path[0] as ManualBookingField]: issue.message,
      } as FieldErrors<ManualBookingField>,
    };
  }

  const value = parsed.data;

  /* The local wall clock into a real instant, in the BUSINESS's zone, refusing
     a time that does not exist on that date. See resolveWallClock. */
  const resolved = resolveWallClock(
    value.date,
    value.startLocal,
    business.timezone,
  );

  if (!resolved.ok) {
    return {
      ok: false,
      message: resolved.message,
      fieldErrors: { startLocal: resolved.message },
    };
  }

  const startsAt = resolved.instant;

  if (!value.override) {
    /**
     * THE SAME CHECK A CUSTOMER GETS, run against the database as it stands.
     *
     * Not a reimplementation of the rules — the availability engine itself,
     * with this service and this staff member. It covers opening hours,
     * closures, lead time, the horizon and the service/staff assignment in one
     * question, which is the only way to be sure the answer matches what the
     * public page would have said.
     */
    const day = await loadDayView({
      db,
      businessId: business.id,
      serviceId: value.serviceId,
      staffId: value.staffId,
      timeZone: business.timezone,
      date: value.date,
    });

    if (!day) {
      return {
        ok: false,
        message: "That service is not one of yours any more. Reload the page.",
        fieldErrors: { serviceId: "Unknown service." },
      };
    }

    if (!day.starts.has(startsAt.toISOString())) {
      return {
        ok: false,
        message:
          "That time is outside what you normally offer — closed, too soon, or not a slot on your grid. Turn on the override if you mean it.",
        nearest: nearestOffers(day.view.offers, startsAt.toISOString(), 3).map(
          (offer) => ({ startsAt: offer.startsAt, endsAt: offer.endsAt }),
        ),
        overridable: true,
      };
    }
  }

  const created = await createManualAppointment(db, {
    businessId: business.id,
    staffId: value.staffId,
    serviceId: value.serviceId,
    startsAt,
    customer: {
      name: value.customerName,
      email: value.customerEmail,
      phone: value.customerPhone,
    },
    customerNote: value.customerNote,
    internalNote: value.internalNote,
    notifyCustomer: value.notifyCustomer,
  });

  if (!created.ok) {
    switch (created.reason) {
      case "slot-taken":
        return {
          ok: false,
          /* THE ONE REFUSAL THE OVERRIDE DOES NOT LIFT, and the message says
             so rather than inviting them to try the toggle. */
          message:
            "That time is already taken for this staff member. The override lets you work outside your hours; it cannot put two appointments in one chair.",
          fieldErrors: { startLocal: "Already booked." },
        };
      case "service-missing":
        return {
          ok: false,
          message: "That service is not one of yours. Reload the page.",
          fieldErrors: { serviceId: "Unknown service." },
        };
      case "staff-missing":
        return {
          ok: false,
          message: "That staff member is not one of yours. Reload the page.",
          fieldErrors: { staffId: "Unknown staff member." },
        };
    }
  }

  if (value.notifyCustomer) {
    /* The outbox rows were written inside the booking transaction. This asks
       the worker to go now rather than waiting for the daily sweep — outside
       the transaction, because it is a network call. */
    await dispatchDeliveries(db, created.appointment.id);
  }

  revalidateCalendar();

  return {
    ok: true,
    appointmentId: created.appointment.id,
    message: value.notifyCustomer
      ? `Booked. ${value.customerName} has been emailed the details.`
      : "Booked. Nothing was emailed.",
    note: resolved.ambiguous ? AMBIGUOUS_TIME_NOTE : undefined,
  };
}

/* ===========================================================================
   The detail sheet's actions
   =========================================================================== */

/** One appointment, in full. Used when the sheet opens. */
export async function readAppointment(
  appointmentId: string,
): Promise<AppointmentDetail | null> {
  const business = await requireOwnerBusiness();

  return loadAppointmentDetail(business.id, appointmentId);
}

export type CancelAsBusinessResult =
  | { ok: true; message: string; refundedCents: number }
  | { ok: false; message: string };

/**
 * The business cancels an appointment.
 *
 * ═══ THE DEPOSIT ALWAYS GOES BACK ═══
 *
 * `businesses.refund_deposit_on_cancel` governs a CUSTOMER's cancellation, and
 * a business that keeps a deposit when the customer changes their mind is
 * running a defensible model. This is the other direction: the customer did
 * nothing, the business is the one not turning up, and keeping their money for
 * it is how a business earns a chargeback. So the setting is not consulted here
 * and the deposit is refunded whenever one was actually taken.
 *
 * The refund happens AFTER the cancellation commits and never inside the
 * transaction — a Stripe call inside it could roll back a cancellation the
 * owner has already been told about, and it would hold a transaction open
 * across a third-party round trip. The consequence is a window where the slot
 * is free and the money has not landed yet, which is the right way round: the
 * reverse is the one nobody can fix.
 */
export async function cancelAppointmentAsBusiness(input: {
  appointmentId: string;
  reason?: string;
}): Promise<CancelAsBusinessResult> {
  const business = await requireOwnerBusiness();

  const parsed = cancelAppointmentSchema.safeParse(input);

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0].message };
  }

  const detail = await loadAppointmentDetail(
    business.id,
    parsed.data.appointmentId,
  );

  if (!detail) {
    return { ok: false, message: "That appointment is not on your calendar." };
  }

  const cancelled = await cancelAppointment(db, {
    appointmentId: detail.id,
    cancelledBy: "business",
    reason: parsed.data.reason,
  });

  if (cancelled.outcome === "already-cancelled") {
    /* A double-click. The first call already refunded and emailed; saying so
       again would refund twice. */
    return {
      ok: true,
      message: "That appointment was already cancelled.",
      refundedCents: cancelled.appointment.refundedCents ?? 0,
    };
  }

  if (cancelled.outcome === "not-cancellable") {
    return {
      ok: false,
      message:
        "Only a confirmed appointment can be cancelled. This one is already finished or cancelled.",
    };
  }

  /* Withdraw the reminder BEFORE writing the cancellation notice, so the sweep
     cannot fire a reminder for an appointment that is not happening. */
  await cancelScheduledDeliveries(db, detail.id);

  const refundedCents = await refundDeposit(detail);

  await db.insert(notifications).values({
    appointmentId: detail.id,
    kind: "cancellation" as const,
    channel: "email" as const,
    toEmail: detail.customer?.email ?? business.contactEmail,
    scheduledFor: new Date(),
  });

  await dispatchDeliveries(db, detail.id);

  revalidateCalendar();

  return {
    ok: true,
    refundedCents,
    message:
      refundedCents > 0
        ? "Cancelled, the customer has been emailed, and the deposit is on its way back."
        : "Cancelled and the customer has been emailed.",
  };
}

/**
 * Put the deposit back. Never throws.
 *
 * A refund that fails is logged at the loudest available volume and the
 * cancellation still stands — an owner who has told a customer the appointment
 * is off must not have that undone by Stripe being slow.
 */
async function refundDeposit(detail: AppointmentDetail): Promise<number> {
  if (detail.depositCents <= 0 || !detail.depositPaid || detail.refundedCents) {
    return 0;
  }

  const [row] = await db
    .select({ paymentIntentId: appointments.stripePaymentIntentId })
    .from(appointments)
    .where(eq(appointments.id, detail.id))
    .limit(1);

  const stripe = getStripe();

  if (!stripe || !row?.paymentIntentId) {
    console.error(
      `[agenda] appointment ${detail.id} was cancelled by the business with a ` +
        "paid deposit but no Stripe payment intent to refund against. Refund it by hand.",
    );

    return 0;
  }

  try {
    const refund = await stripe.refunds.create({
      payment_intent: row.paymentIntentId,
      metadata: {
        [CHECKOUT_METADATA.app]: OWNER_TAG,
        [CHECKOUT_METADATA.appointmentId]: detail.id,
        reason: "cancelled_by_business",
      },
    });

    /* Stamped on the row so the `charge.refunded` webhook recognises this as
       OUR refund and does not alarm the owner about it a second time. */
    await db
      .update(appointments)
      .set({ refundedAt: new Date(), refundedCents: refund.amount })
      .where(eq(appointments.id, detail.id));

    return refund.amount;
  } catch (error) {
    console.error(
      `[agenda] REFUND FAILED for appointment ${detail.id}, cancelled by the ` +
        "business. The appointment IS cancelled and the customer has NOT been " +
        "refunded — do it by hand.",
      error,
    );

    return 0;
  }
}

/**
 * Mark an appointment completed, or as a no-show.
 *
 * Nothing is emailed either way. "You did not turn up" is a conversation a
 * business may want to have and is not one this product should have on their
 * behalf, and "that went well" is not a message anybody wants.
 */
export async function settleAppointmentAsBusiness(input: {
  appointmentId: string;
  outcome: "completed" | "no_show";
}): Promise<MutationResult> {
  const business = await requireOwnerBusiness();

  const parsed = settleAppointmentSchema.safeParse(input);

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0].message };
  }

  const settled = await settleAppointment(db, {
    appointmentId: parsed.data.appointmentId,
    businessId: business.id,
    outcome: parsed.data.outcome,
  });

  if (!settled.ok) {
    return {
      ok: false,
      message:
        "Only a confirmed appointment can be marked. This one is already finished or cancelled.",
    };
  }

  /* The reminder is withdrawn: the appointment has happened, one way or the
     other, and a reminder for it now would be nonsense. */
  await cancelScheduledDeliveries(db, parsed.data.appointmentId);

  revalidateCalendar();

  return {
    ok: true,
    message:
      parsed.data.outcome === "completed"
        ? "Marked as done."
        : "Marked as a no-show. Nothing was emailed.",
  };
}

/** The business's private note. Never shown to the customer. */
export async function saveInternalNote(input: {
  appointmentId: string;
  note: string;
}): Promise<MutationResult> {
  const business = await requireOwnerBusiness();

  const parsed = internalNoteSchema.safeParse(input);

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0].message };
  }

  const saved = await setInternalNote(db, {
    appointmentId: parsed.data.appointmentId,
    businessId: business.id,
    note: parsed.data.note,
  });

  if (!saved) {
    return { ok: false, message: "That appointment is not on your calendar." };
  }

  revalidateCalendar();

  return { ok: true, message: "Note saved. Only you can see it." };
}

/* ===========================================================================
   BLOCK TIME — drag on the ribbon, or fill in the same fields
   =========================================================================== */

export type BlockTimeResult =
  | {
      ok: true;
      message: string;
      /** The row's id, so the toast can offer an undo that actually undoes. */
      timeOffId: string;
    }
  | { ok: false; message: string };

/**
 * Block a stretch of one day.
 *
 * INSTANT AND UNDOABLE, which is a different contract from the time-off screen
 * next door. That form holds a closure back for review when it would sit on
 * live appointments, because planning a week's holiday over somebody's booking
 * deserves a second look. This is a two-second gesture on the day being looked
 * at, and interrupting it with a confirmation dialog would make the gesture
 * useless — so it writes immediately, SAYS how many appointments it landed on,
 * and hands back the id so the toast can undo it in one press.
 *
 * Blocking does NOT cancel the appointments underneath it. They stay exactly
 * where they are, still owned by their customer; the block only stops new
 * bookings landing there. Cancelling somebody is a deliberate act and it lives
 * in the detail sheet.
 */
export async function blockTime(
  input: BlockTimeInput,
): Promise<BlockTimeResult> {
  const business = await requireOwnerBusiness();

  const parsed = blockTimeSchema.safeParse(input);

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0].message };
  }

  const value = parsed.data;

  if (value.staffId) {
    const [member] = await db
      .select({ id: staff.id })
      .from(staff)
      .where(
        and(eq(staff.id, value.staffId), eq(staff.businessId, business.id)),
      )
      .limit(1);

    if (!member) {
      return { ok: false, message: "That staff member no longer exists." };
    }
  }

  const start = resolveWallClock(value.date, value.startLocal, business.timezone);
  const end = resolveWallClock(value.date, value.endLocal, business.timezone);

  if (!start.ok) {
    return { ok: false, message: start.message };
  }
  if (!end.ok) {
    return { ok: false, message: end.message };
  }

  if (end.instant.getTime() <= start.instant.getTime()) {
    return { ok: false, message: "The end has to come after the start." };
  }

  const range = toTstzRangeLiteral(start.instant, end.instant);

  /* Counted, not refused. The owner is told what they just sat on top of. */
  const conflicts = await findConflictingAppointments(
    business.id,
    range,
    value.staffId,
  );

  const [created] = await db
    .insert(timeOff)
    .values({
      businessId: business.id,
      staffId: value.staffId,
      range,
      reason: value.reason,
      isAllDay: false,
    })
    .returning({ id: timeOff.id });

  revalidateCalendar();
  revalidatePath("/admin/time-off");

  return {
    ok: true,
    timeOffId: created.id,
    message:
      conflicts.length === 0
        ? "Time blocked."
        : `Time blocked. ${conflicts.length} appointment${
            conflicts.length === 1 ? "" : "s"
          } already there — ${
            conflicts.length === 1 ? "it stays" : "they stay"
          } in the calendar.`,
  };
}

/** The undo behind the toast. Scoped to the business, like everything else. */
export async function unblockTime(timeOffId: string): Promise<MutationResult> {
  const business = await requireOwnerBusiness();

  const [deleted] = await db
    .delete(timeOff)
    .where(
      and(eq(timeOff.id, timeOffId), eq(timeOff.businessId, business.id)),
    )
    .returning({ id: timeOff.id });

  if (!deleted) {
    return { ok: false, message: "That block is already gone." };
  }

  revalidateCalendar();
  revalidatePath("/admin/time-off");

  return { ok: true, message: "Block removed." };
}

/* ===========================================================================
   Small helper the manual-booking form uses for its default date
   =========================================================================== */

/** The business's own today, so a form opened at 23:50 in Auckland is right. */
export async function businessToday(): Promise<string> {
  const business = await requireOwnerBusiness();

  return localDateOf(new Date(), business.timezone);
}
