"use server";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { appointments, notifications } from "@/db/schema";
import type {
  CancelResult,
  ManageRefusal,
  RescheduleDayResult,
  RescheduleResult,
} from "@/lib/booking/manage-actions";
import { LOCAL_DATE_PATTERN } from "@/lib/booking/url";
import {
  cancelScheduledDeliveries,
  dispatchDeliveries,
  rescheduleReminder,
} from "@/lib/notifications/delivery";
import {
  CHECKOUT_METADATA,
  OWNER_TAG,
  refundIdempotencyKey,
} from "@/lib/payments/checkout";
import { getStripe } from "@/lib/payments/stripe";
import {
  cancelAppointment,
  moveAppointment,
} from "@/lib/scheduling/booking";
import { loadDayView, nearestOffers } from "@/lib/scheduling/day-view";
import {
  resolveManageToken,
  type ManageView,
} from "@/server/booking/manage";
import {
  clientAddressOf,
  consumeRateLimit,
  MANAGE_IP_RULE,
  MANAGE_TOKEN_RULE,
  rateLimitKey,
} from "@/server/booking/rate-limit";

/**
 * Everything a customer can do to their own appointment without an account.
 *
 * ═══ EVERY ACTION REPEATS THE WHOLE CHECK ═══
 *
 * A Server Action is a public HTTP endpoint. Nothing the page decided when it
 * rendered is trusted here: the token is resolved again, the rate limit is
 * counted again, the policy window is measured again against the clock as it
 * is NOW, and — for a move — the availability engine is re-run against the
 * database as it stands. A page can sit open for an hour, and in that hour the
 * cancellation window closes, the business turns reschedule off, and somebody
 * else takes the slot.
 *
 * ═══ AND EVERY ACTION IS IDEMPOTENT ═══
 *
 * The two write paths are guarded in SQL rather than by a flag: a cancel
 * matches `WHERE status = 'confirmed'`, so exactly one of two concurrent
 * clicks updates a row, and the refund hangs off that one answer. A move
 * compares the instant first and does nothing when it already matches. Both
 * report success either way, because from the customer's point of view the
 * thing they asked for is true.
 */

/* ===========================================================================
   The gate every action goes through
   =========================================================================== */

const tokenSchema = z.string().min(16).max(256);

type Gate =
  | { ok: true; view: ManageView }
  | { ok: false; refusal: ManageRefusal };

function refuse(
  code: ManageRefusal["code"],
  message: string,
  extra: Partial<ManageRefusal> = {},
): { ok: false; refusal: ManageRefusal } {
  return { ok: false, refusal: { ok: false, code, message, ...extra } };
}

/** The one message an unusable link gets, from every action. */
const DEAD_LINK =
  "This link is not valid any more. Check the most recent email you had about " +
  "the booking — the link in it always points at the current version.";

/**
 * Rate-limit, then resolve.
 *
 * IN THAT ORDER, and the order is the point: counting only the requests that
 * name a real appointment would let somebody guess at tokens for free. The IP
 * bucket is counted first because it is the one that bounds a search, and both
 * are counted even when one has already refused — a limiter that stops
 * counting once it starts refusing lets an attacker keep their allowance warm.
 */
async function gate(token: string): Promise<Gate> {
  const parsed = tokenSchema.safeParse(token);

  if (!parsed.success) {
    return refuse("unauthorized", DEAD_LINK);
  }

  const address = clientAddressOf({ headers: await headers() });

  const [byAddress, byToken] = await Promise.all([
    consumeRateLimit(
      db,
      rateLimitKey("manage:ip", address),
      MANAGE_IP_RULE,
    ),
    consumeRateLimit(
      db,
      rateLimitKey("manage:token", parsed.data),
      MANAGE_TOKEN_RULE,
    ),
  ]);

  if (!byAddress.allowed || !byToken.allowed) {
    return refuse(
      "rate-limited",
      "That is a lot of requests in a short time. Give it a minute and try again.",
    );
  }

  const resolved = await resolveManageToken(db, parsed.data);

  if (resolved.status !== "ok") {
    return refuse("unauthorized", DEAD_LINK);
  }

  return { ok: true, view: resolved.view };
}

/* ===========================================================================
   The reschedule picker's data
   =========================================================================== */

const dateSchema = z.string().regex(LOCAL_DATE_PATTERN);

/**
 * One day of availability, scoped to THIS appointment's service and staff.
 *
 * The customer is moving an appointment, not booking a different one, so the
 * service and the staff member come off the row and are never taken from the
 * caller. An action that accepted them would let anybody browse any staff
 * member's diary with one leaked token.
 *
 * Their own appointment is excluded from the availability computation, so the
 * slot they currently hold comes back as offerable rather than as taken —
 * which is what lets them see where they are before deciding where to go.
 */
export async function loadRescheduleDay(
  token: string,
  date: string,
): Promise<RescheduleDayResult> {
  const allowed = await gate(token);

  if (!allowed.ok) {
    return allowed.refusal;
  }

  const parsedDate = dateSchema.safeParse(date);

  if (!parsedDate.success) {
    return { ok: false, code: "error", message: "That is not a day we can show." };
  }

  const view = await dayFor(allowed.view, parsedDate.data);

  if (!view) {
    return {
      ok: false,
      code: "error",
      message: "We could not draw that day just now. Try again in a moment.",
    };
  }

  return { ok: true, day: view.view };
}

function dayFor(view: ManageView, date: string) {
  return loadDayView({
    db,
    businessId: view.businessId,
    serviceId: view.serviceId,
    staffId: view.staffId,
    timeZone: view.timeZone,
    date,
    excludeAppointmentId: view.appointmentId,
    anchorStartsAt: view.booking.times.startsAt,
  });
}

/* ===========================================================================
   Reschedule
   =========================================================================== */

const startsAtSchema = z.string().datetime({ offset: true });

export async function rescheduleBooking(
  token: string,
  startsAt: string,
): Promise<RescheduleResult> {
  const allowed = await gate(token);

  if (!allowed.ok) {
    return allowed.refusal;
  }

  const view = allowed.view;

  /* THE POLICY, MEASURED NOW. The page decided this when it rendered; an hour
     may have passed since. */
  if (!view.permissions.canReschedule) {
    return {
      ok: false,
      code: "not-allowed",
      message:
        view.permissions.rescheduleRefusal ??
        "This appointment cannot be moved from here.",
    };
  }

  const parsed = startsAtSchema.safeParse(startsAt);

  if (!parsed.success) {
    return { ok: false, code: "error", message: "That is not a time we offer." };
  }

  const wanted = new Date(parsed.data);
  const date = localDateOf(wanted, view.timeZone);

  /**
   * THE CATCH-ALL, re-run against the database as it stands.
   *
   * The picker drew this day at some point in the past. Since then the hours
   * could have changed, the owner could have blocked the afternoon, the lead
   * time could have caught up, or somebody could have booked it. Asking the
   * whole availability engine again is the only check that covers all of them,
   * and it costs one query on a path a customer takes once.
   */
  const day = await dayFor(view, date);

  if (!day) {
    return {
      ok: false,
      code: "error",
      message: "We could not check that time just now. Try again in a moment.",
    };
  }

  if (!day.starts.has(wanted.toISOString())) {
    return {
      ok: false,
      code: "unavailable",
      message:
        "That time is not being offered any more. Here is how the day looks now.",
      day: day.view,
      nearest: nearestOffers(day.view.offers, wanted.toISOString()),
    };
  }

  const moved = await moveAppointment(db, {
    appointmentId: view.appointmentId,
    startsAt: wanted,
  });

  switch (moved.outcome) {
    case "unchanged":
      /* A double submit. Nothing was written and nothing is emailed — the
         appointment is already exactly where they asked for it to be. */
      return {
        ok: true,
        startsAt: moved.appointment.startsAt.toISOString(),
        endsAt: moved.appointment.endsAt.toISOString(),
        changed: false,
      };

    case "slot-taken": {
      const fresh = await dayFor(view, date);

      return {
        ok: false,
        code: "slot-taken",
        message:
          "That time was taken while you were deciding. Your appointment has not moved — pick another time.",
        day: fresh?.view,
        nearest: fresh
          ? nearestOffers(fresh.view.offers, wanted.toISOString())
          : undefined,
      };
    }

    case "not-movable":
      return {
        ok: false,
        code: "not-allowed",
        message:
          moved.status === "cancelled"
            ? "This appointment has been cancelled, so there is nothing to move."
            : "This appointment can no longer be moved from here.",
      };

    case "moved": {
      /**
       * THE OUTBOX, after the move committed.
       *
       * Two messages, one payload: the customer's updated invite — same UID, a
       * higher sequence, so their calendar MOVES the event — and the owner's
       * copy, because the diary changed without anybody at the business
       * touching it.
       */
      const payload = {
        kind: "reschedule" as const,
        previousStartsAt: moved.previous.startsAt.toISOString(),
        previousEndsAt: moved.previous.endsAt.toISOString(),
        movedBy: "customer" as const,
      };

      const now = new Date();

      await db.insert(notifications).values([
        {
          appointmentId: view.appointmentId,
          kind: "reschedule" as const,
          channel: "email" as const,
          toEmail: view.booking.customerEmail,
          scheduledFor: now,
          payload,
        },
        {
          appointmentId: view.appointmentId,
          kind: "owner_reschedule" as const,
          channel: "email" as const,
          toEmail: view.contact.email,
          scheduledFor: now,
          payload,
        },
      ]);

      /**
       * The reminder was published for the OLD time. This withdraws it, calls
       * the scheduled message off, queues a new one against the new time — or
       * none at all, if the appointment moved to inside the reminder window —
       * and dispatches everything pending, the two messages above included.
       */
      await rescheduleReminder(db, view.appointmentId);

      revalidatePath(`/manage/${token}`);

      return {
        ok: true,
        startsAt: moved.appointment.startsAt.toISOString(),
        endsAt: moved.appointment.endsAt.toISOString(),
        changed: true,
      };
    }
  }
}

/* ===========================================================================
   Cancel
   =========================================================================== */

export async function cancelBooking(token: string): Promise<CancelResult> {
  const allowed = await gate(token);

  if (!allowed.ok) {
    return allowed.refusal;
  }

  const view = allowed.view;

  if (!view.permissions.canCancel) {
    return {
      ok: false,
      code: "not-allowed",
      message:
        view.permissions.cancelRefusal ??
        "This appointment cannot be cancelled from here.",
    };
  }

  const cancelled = await cancelAppointment(db, {
    appointmentId: view.appointmentId,
    cancelledBy: "customer",
    reason: null,
  });

  if (cancelled.outcome === "already-cancelled") {
    /**
     * ═══ THE DOUBLE-CLICK ═══
     *
     * The row was already cancelled, which means another call — the same
     * button pressed twice, the same customer on two devices — got there
     * first and has ALREADY refunded and emailed. Returning success without
     * touching Stripe is the entire reason `cancelAppointment` reports this
     * separately, and it is what stops a second refund being attempted.
     */
    return {
      ok: true,
      refundedCents: cancelled.appointment.refundedCents ?? 0,
      changed: false,
    };
  }

  if (cancelled.outcome === "not-cancellable") {
    return {
      ok: false,
      code: "not-allowed",
      message: "This appointment can no longer be cancelled from here.",
    };
  }

  /* Withdraw everything still queued BEFORE writing the cancellation, so the
     sweep cannot fire a reminder for an appointment that is not happening. The
     two messages below are written after, so they are not caught by it. */
  await cancelScheduledDeliveries(db, view.appointmentId);

  const refundedCents = await refundIfPolicySays(view, cancelled.appointment.id);

  const now = new Date();

  await db.insert(notifications).values([
    {
      appointmentId: view.appointmentId,
      kind: "cancellation" as const,
      channel: "email" as const,
      toEmail: view.booking.customerEmail,
      scheduledFor: now,
    },
    {
      appointmentId: view.appointmentId,
      kind: "owner_cancellation" as const,
      channel: "email" as const,
      toEmail: view.contact.email,
      scheduledFor: now,
    },
  ]);

  await dispatchDeliveries(db, view.appointmentId);

  revalidatePath(`/manage/${token}`);

  return { ok: true, refundedCents, changed: true };
}

/**
 * Put the deposit back, when the business's policy says to.
 *
 * ═══ AFTER THE CANCELLATION COMMITTED, NEVER INSIDE IT ═══
 *
 * A refund is an HTTP call to Stripe. Inside the transaction it could roll a
 * cancellation back — leaving a customer who pressed Cancel with an
 * appointment they think is gone — and it would hold a database transaction
 * open across a third-party round trip. So the diary is settled first and the
 * money follows.
 *
 * The consequence is a window in which the appointment is cancelled and the
 * refund has not landed. That is the right way round: the slot is free, the
 * customer has what they asked for, and a refund that failed is visible in the
 * log and fixable by a human. The reverse — money back, appointment still in
 * the diary — is the one nobody can fix.
 *
 * NEVER THROWS. A failed refund is logged at the loudest available volume and
 * the cancellation still stands.
 */

/** This path's one reason, used in the metadata and in the idempotency key. */
const REFUND_REASON = "cancelled_by_customer_within_policy" as const;

async function refundIfPolicySays(
  view: ManageView,
  appointmentId: string,
): Promise<number> {
  if (!view.refundDepositOnCancel) {
    /* The policy keeps it — and the customer was told so, in words, on the
       confirm screen before they pressed the button. See
       `describeCancellationOutcome`. */
    return 0;
  }

  if (view.booking.depositCents <= 0 || !view.booking.depositPaid) {
    return 0;
  }

  const [row] = await db
    .select({ paymentIntentId: appointments.stripePaymentIntentId })
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .limit(1);

  const stripe = getStripe();

  if (!stripe || !row?.paymentIntentId) {
    console.error(
      `[manage] appointment ${appointmentId} was cancelled with a paid deposit ` +
        "but no Stripe payment intent to refund against. Refund it by hand.",
    );

    return 0;
  }

  try {
    const refund = await stripe.refunds.create(
      {
        payment_intent: row.paymentIntentId,
        metadata: {
          [CHECKOUT_METADATA.app]: OWNER_TAG,
          [CHECKOUT_METADATA.appointmentId]: appointmentId,
          reason: REFUND_REASON,
        },
      },
      {
        /**
         * Cancelling is a Server Action, which means a double click or a
         * retried request whose response was lost can reach this twice. The
         * key makes the second call return the first refund rather than issue
         * a second one. See `refundIdempotencyKey`.
         */
        idempotencyKey: refundIdempotencyKey(appointmentId, REFUND_REASON),
      },
    );

    /* Stamped on the row so the `charge.refunded` webhook recognises this as
       OUR refund and does not alarm the owner about it a second time. */
    await db
      .update(appointments)
      .set({ refundedAt: new Date(), refundedCents: refund.amount })
      .where(eq(appointments.id, appointmentId));

    /* Every refund this application issues is logged, successful or not — the
       money trail should be readable without opening Stripe. */
    console.info(
      `[manage] refunded ${refund.amount} to appointment ${appointmentId} ` +
        `(refund ${refund.id}, payment intent ${row.paymentIntentId}, ` +
        `reason ${REFUND_REASON})`,
    );

    return refund.amount;
  } catch (error) {
    console.error(
      `[manage] REFUND FAILED for cancelled appointment ${appointmentId}. ` +
        "The appointment IS cancelled and the customer has NOT been refunded — " +
        "do it by hand.",
      error,
    );

    return 0;
  }
}

/** The calendar date an instant falls on, in the business's zone. */
function localDateOf(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}
