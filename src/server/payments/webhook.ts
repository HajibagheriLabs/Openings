import "server-only";

import { eq, sql } from "drizzle-orm";
import type Stripe from "stripe";

import { db } from "@/db";
import {
  appointments as appointmentsTable,
  businesses,
  customers,
  notifications,
  services,
  webhookEvents,
  type Appointment,
} from "@/db/schema";
import { bookingUrl } from "@/lib/booking/url";
import {
  cancelScheduledDeliveries,
  dispatchDeliveries,
} from "@/lib/notifications/delivery";
import type { OfferedTime } from "@/lib/notifications/payload";
import {
  CHECKOUT_METADATA,
  isOwnObject,
  OWNER_TAG,
} from "@/lib/payments/checkout";
import { getStripe } from "@/lib/payments/stripe";
import {
  abandonHold,
  CANCELLATION_REASON,
  confirmPaidHold,
} from "@/lib/scheduling/booking";
import { loadDayView } from "@/lib/scheduling/day-view";
import { localDateOf } from "@/server/booking/picker";

/**
 * What a verified Stripe event does to this database.
 *
 * ═══ A VALID SIGNATURE DOES NOT MEAN THE EVENT IS OURS. ═══
 *
 * That is the first thing to understand about this file. The webhook signing
 * secret belongs to a Stripe ACCOUNT, not to an application, and this project
 * shares a test-mode account with another one. `stripe listen` forwards every
 * event on that account to whatever endpoint it is pointed at, and every one of
 * them carries a signature that verifies perfectly against our secret. So
 * signature verification answers "did Stripe send this?" and nothing else.
 *
 * Ownership is answered separately, by the `app: openings` tag written onto
 * every object this application creates (see OWNER_TAG). An event without it is
 * somebody else's and is acknowledged with a 200 and no processing. Without
 * that check, another project's payments would be looked up in `appointments`,
 * found missing, and logged as poison events on every single charge.
 *
 * The second thing: NOTHING HERE COMPOSES OR SENDS A MESSAGE INSIDE A
 * TRANSACTION. Messages are rows in `notifications`, written with the booking;
 * a worker delivers them. After the transaction commits, `dispatchDeliveries`
 * hands those rows to the delivery service — or, when none is configured,
 * sends the already-due ones inline so the product still works on a machine
 * with nothing but a database. Either way it is after the commit, and either
 * way it cannot throw: a slow mail provider must never turn a successful
 * payment into a 500 that Stripe then retries.
 */

/** Every event type this application acts on. Anything else is acknowledged. */
export const HANDLED_EVENTS = [
  "checkout.session.completed",
  "checkout.session.expired",
  "charge.refunded",
] as const;

export type WebhookOutcome =
  /** Somebody else's event, or a type we do not act on. Acknowledged, untouched. */
  | { status: "ignored"; reason: string }
  /** Already processed. Stripe retried; the guard caught it. */
  | { status: "duplicate" }
  /** Handled. `detail` is for the log, never for a customer. */
  | { status: "handled"; detail: string }
  /**
   * Ours, but nothing in the database matches it. Logged loudly and STILL
   * acknowledged: retrying a poison event forever helps nobody, and Stripe
   * will keep trying for days if it does not get a 200.
   */
  | { status: "unresolved"; detail: string };

/* ===========================================================================
   Dispatch
   =========================================================================== */

/**
 * Record the event, then act on it. In that order, and the order is the point.
 *
 * IDEMPOTENCY FIRST. `webhook_events` has the Stripe event id as its PRIMARY
 * KEY, so the insert is the guard: it succeeds once and conflicts forever
 * after. Stripe retries on any non-2xx and can deliver the same event more
 * than once regardless, and without this a retry would queue a second
 * confirmation email for a booking that was already made.
 *
 * The ownership check runs BEFORE the insert on purpose — `webhook_events` is
 * this application's record of what it processed, and filling it with another
 * project's event ids would make it useless as exactly that.
 */
export async function handleStripeEvent(
  event: Stripe.Event,
): Promise<WebhookOutcome> {
  if (!HANDLED_EVENTS.includes(event.type as (typeof HANDLED_EVENTS)[number])) {
    return { status: "ignored", reason: `unhandled type ${event.type}` };
  }

  if (!belongsToUs(event)) {
    return { status: "ignored", reason: "not tagged for this application" };
  }

  const recorded = await db
    .insert(webhookEvents)
    .values({ id: event.id, type: event.type })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });

  if (recorded.length === 0) {
    return { status: "duplicate" };
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        return await onCheckoutCompleted(event.data.object);
      case "checkout.session.expired":
        return await onCheckoutExpired(event.data.object);
      case "charge.refunded":
        return await onChargeRefunded(event.data.object);
      default:
        return { status: "ignored", reason: `unhandled type ${event.type}` };
    }
  } catch (error) {
    /**
     * TAKE THE GUARD BACK DOWN.
     *
     * The row above means "this event was processed". If handling threw — the
     * database went away mid-transaction, say — it was not, and leaving the row
     * behind would make Stripe's retry look like a duplicate and be swallowed
     * silently. A booking that was paid for would then never be confirmed and
     * nothing would ever say so.
     *
     * So the guard is released and the error is rethrown, which returns a 500
     * and asks Stripe to try again. Deleting a row that a concurrent delivery
     * is also working on is harmless: that delivery is inside its own
     * transaction, and the worst case is one extra attempt that finds the
     * appointment already confirmed and reports a replay.
     */
    await db
      .delete(webhookEvents)
      .where(eq(webhookEvents.id, event.id))
      .catch(() => {
        /* Nothing useful to do; the original error is the one that matters. */
      });

    throw error;
  }
}

/**
 * Is this event about one of our objects?
 *
 * Sessions carry the tag directly. A charge carries whatever its PaymentIntent
 * carried, which is our tag too — but a charge created any other way would not,
 * so `onChargeRefunded` also falls back to looking the PaymentIntent up in our
 * own table before deciding the event is a stranger's.
 */
function belongsToUs(event: Stripe.Event): boolean {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.expired":
      return isOwnObject(event.data.object.metadata);
    case "charge.refunded":
      /* Untagged charges still reach the handler, which resolves them by
         payment intent against our own rows. See `onChargeRefunded`. */
      return true;
    default:
      return false;
  }
}

/** The appointment id a session names, from metadata or the reference. */
function appointmentIdOf(session: Stripe.Checkout.Session): string | null {
  return (
    session.metadata?.[CHECKOUT_METADATA.appointmentId] ??
    session.client_reference_id ??
    null
  );
}

/** Stripe hands ids back either bare or expanded. Take the id either way. */
function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) {
    return null;
  }

  return typeof value === "string" ? value : value.id;
}

/* ===========================================================================
   checkout.session.completed — the booking actually happens
   =========================================================================== */

async function onCheckoutCompleted(
  session: Stripe.Checkout.Session,
): Promise<WebhookOutcome> {
  const appointmentId = appointmentIdOf(session);
  const paymentIntentId = idOf(session.payment_intent);

  if (!appointmentId) {
    console.error(
      `[stripe] checkout session ${session.id} is tagged ${OWNER_TAG} but names no appointment`,
    );

    return { status: "unresolved", detail: `session ${session.id}` };
  }

  const result = await confirmPaidHold(db, { appointmentId, paymentIntentId });

  switch (result.outcome) {
    case "confirmed": {
      /**
       * AFTER THE TRANSACTION, NEVER INSIDE IT.
       *
       * The booking is committed and the money is taken; this only decides
       * how quickly the queued messages leave. `dispatchDeliveries` publishes
       * them to the delivery service — the confirmation for now, the reminder
       * for its exact minute — or, with no service configured, sends what is
       * due inline. It never throws: a slow QStash must not be able to turn a
       * successful payment into a 500 that Stripe then retries.
       */
      const dispatched = await dispatchDeliveries(db, appointmentId);

      return {
        status: "handled",
        detail:
          `confirmed appointment ${appointmentId} ` +
          `(${dispatched.scheduler}: ${dispatched.scheduled} scheduled, ` +
          `${dispatched.sentNow} sent, ${dispatched.deferred} deferred)`,
      };
    }

    case "already-confirmed":
      /* A different event id for the same booking — a resend from the
         dashboard, or `payment_intent.succeeded` behaviour we do not act on.
         The transaction wrote nothing, which is the whole point. */
      return {
        status: "handled",
        detail: `appointment ${appointmentId} was already confirmed`,
      };

    case "slot-lost":
      return refundAndApologise(result.appointment, paymentIntentId, session);

    case "not-found":
      /**
       * OURS BY THE TAG, BUT NOT IN THE DATABASE.
       *
       * A test event triggered by hand, a row deleted out from under a payment,
       * or a database restored from before the booking. Logged loudly because
       * it means somebody may have paid for nothing — and acknowledged anyway,
       * because Stripe retrying this for three days will not make the row
       * appear.
       */
      console.error(
        `[stripe] POISON EVENT: checkout session ${session.id} names appointment ` +
          `${appointmentId}, which does not exist. Payment intent ${paymentIntentId ?? "none"}. ` +
          `If money was taken it must be refunded by hand.`,
      );

      return { status: "unresolved", detail: `appointment ${appointmentId}` };
  }
}

/* ===========================================================================
   THE HARD CASE — paid for a slot that had already gone
   =========================================================================== */

/**
 * Rare, real, and the thing that separates a booking product from a demo.
 *
 * The sequence: the customer opens Stripe with four minutes left on their hold,
 * takes six, and pays. In those two minutes the hold lapsed and the next person
 * to book that time swept it — the slot is genuinely somebody else's now, and
 * the exclusion constraint is right to refuse it. There is no clever recovery:
 * the time is gone.
 *
 * What is left is doing right by the person whose card was charged, and doing
 * it without a human noticing first:
 *
 *   1. REFUND, in full, immediately. Before anything else, because it is the
 *      part with a clock on it.
 *   2. Record the refund and the cancellation on the row, with a reason a
 *      person reading the admin agenda will understand.
 *   3. Queue an apology that names the three nearest openings, so the reply to
 *      "your slot went" is an offer rather than a dead end.
 *   4. Log it, because a business owner should be able to find out this
 *      happened without being told by the customer.
 */
async function refundAndApologise(
  appointment: Appointment,
  paymentIntentId: string | null,
  session: Stripe.Checkout.Session,
): Promise<WebhookOutcome> {
  const stripe = getStripe();
  const amount = session.amount_total ?? appointment.depositCents;

  let refundedCents = 0;

  if (stripe && paymentIntentId) {
    try {
      const refund = await stripe.refunds.create({
        payment_intent: paymentIntentId,
        /* Tagged like everything else, and with a reason a human scanning the
           dashboard can act on without opening the application. */
        metadata: {
          [CHECKOUT_METADATA.app]: OWNER_TAG,
          [CHECKOUT_METADATA.appointmentId]: appointment.id,
          reason: "slot_taken_before_payment_landed",
        },
      });

      refundedCents = refund.amount;
    } catch (error) {
      /**
       * The refund failed and the customer is out of pocket.
       *
       * There is nothing useful to retry inside a webhook — Stripe would
       * redeliver the whole event and try to confirm the booking again — so
       * this is logged at the loudest available volume and the appointment is
       * still cancelled and the apology still queued. A human has to finish it.
       */
      console.error(
        `[stripe] REFUND FAILED for appointment ${appointment.id}, payment intent ` +
          `${paymentIntentId}. The slot was lost and the customer has NOT been ` +
          `refunded — do it by hand.`,
        error,
      );
    }
  }

  const alternatives = await findAlternatives(appointment);

  await db.transaction(async (tx) => {
    await tx
      .update(appointmentsTable)
      .set({
        status: "cancelled",
        holdExpiresAt: null,
        stripePaymentIntentId: paymentIntentId,
        cancelledAt: new Date(),
        cancelledBy: "business",
        cancellationReason: CANCELLATION_REASON.slotLostAfterPayment,
        refundedAt: refundedCents > 0 ? new Date() : null,
        refundedCents: refundedCents > 0 ? refundedCents : null,
      })
      .where(eq(appointmentsTable.id, appointment.id));

    const [contact] = await tx
      .select({
        email: customers.email,
        currency: businesses.currency,
        slug: businesses.slug,
      })
      .from(appointmentsTable)
      .innerJoin(customers, eq(customers.id, appointmentsTable.customerId))
      .innerJoin(businesses, eq(businesses.id, appointmentsTable.businessId))
      .where(eq(appointmentsTable.id, appointment.id))
      .limit(1);

    if (contact) {
      await tx.insert(notifications).values({
        appointmentId: appointment.id,
        kind: "slot_lost",
        channel: "email",
        toEmail: contact.email,
        scheduledFor: new Date(),
        payload: {
          kind: "slot_lost",
          refundedCents: refundedCents || amount,
          currency: contact.currency,
          alternatives,
          rebookPath: bookingUrl(contact.slug, {
            service: appointment.serviceId,
          }),
        },
      });
    }
  });

  /**
   * The appointment is cancelled, so anything still queued against it is no
   * longer true. In practice a lost slot never reached `confirmed` and so has
   * no reminder — but the apology row was written a moment ago and this is the
   * one place that guarantees nothing else is left waiting to contradict it.
   * The apology itself is dispatched below, after the withdrawal, so it cannot
   * be caught by it.
   */
  await cancelScheduledDeliveries(db, appointment.id, {
    kinds: ["reminder", "confirmation", "new_booking"],
  });

  await dispatchDeliveries(db, appointment.id);

  console.error(
    `[stripe] SLOT LOST: appointment ${appointment.id} was paid for after its hold ` +
      `lapsed and the time had gone. Refunded ${refundedCents} cents, cancelled, ` +
      `apology queued with ${alternatives.length} alternative time(s).`,
  );

  return { status: "handled", detail: `refunded and cancelled ${appointment.id}` };
}

/**
 * The three nearest openings for the same service, starting from the day the
 * lost appointment was on.
 *
 * Deliberately not "any time in the next month": somebody who wanted Thursday
 * at two wants something near Thursday at two, and a list reaching three weeks
 * out reads as a brush-off. A week of lookahead is enough to find three
 * openings at any business with a pulse, and if it is not, the email says so
 * and points at the picker.
 */
const ALTERNATIVE_COUNT = 3;
const ALTERNATIVE_LOOKAHEAD_DAYS = 7;

async function findAlternatives(
  appointment: Appointment,
): Promise<OfferedTime[]> {
  const [context] = await db
    .select({
      timeZone: businesses.timezone,
      serviceActive: services.isActive,
    })
    .from(businesses)
    .innerJoin(services, eq(services.id, appointment.serviceId))
    .where(eq(businesses.id, appointment.businessId))
    .limit(1);

  if (!context || !context.serviceActive) {
    return [];
  }

  const now = new Date();
  const wanted = appointment.startsAt.getTime();
  const offers: OfferedTime[] = [];

  for (let day = 0; day < ALTERNATIVE_LOOKAHEAD_DAYS; day += 1) {
    const date = localDateOf(
      new Date(appointment.startsAt.getTime() + day * 86_400_000).toISOString(),
      context.timeZone,
    );

    const view = await loadDayView({
      db,
      businessId: appointment.businessId,
      serviceId: appointment.serviceId,
      /* ANY staff, not the one who was booked. The person whose slot just went
         cares about the time far more than about which chair. */
      staffId: "any",
      timeZone: context.timeZone,
      date,
      now,
    });

    if (view) {
      offers.push(
        ...view.view.offers.map((offer) => ({
          startsAt: offer.startsAt,
          endsAt: offer.endsAt,
        })),
      );
    }

    /* Enough to choose from without walking the whole week for a busy salon. */
    if (offers.length >= ALTERNATIVE_COUNT * 3) {
      break;
    }
  }

  return offers
    .sort(
      (a, b) =>
        Math.abs(Date.parse(a.startsAt) - wanted) -
        Math.abs(Date.parse(b.startsAt) - wanted),
    )
    .slice(0, ALTERNATIVE_COUNT)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

/* ===========================================================================
   checkout.session.expired — nobody paid, give the slot back
   =========================================================================== */

async function onCheckoutExpired(
  session: Stripe.Checkout.Session,
): Promise<WebhookOutcome> {
  const appointmentId = appointmentIdOf(session);

  if (!appointmentId) {
    console.error(
      `[stripe] expired session ${session.id} names no appointment`,
    );

    return { status: "unresolved", detail: `session ${session.id}` };
  }

  /* False is the ordinary answer, not a failure: the customer almost always
     came back through cancel_url, or the hold lapsed and was swept, long before
     Stripe got round to expiring the session half an hour later. */
  const released = await abandonHold(
    db,
    appointmentId,
    CANCELLATION_REASON.checkoutAbandoned,
  );

  return {
    status: "handled",
    detail: released
      ? `released the hold on ${appointmentId}`
      : `nothing held on ${appointmentId}`,
  };
}

/* ===========================================================================
   charge.refunded — money went back
   =========================================================================== */

/**
 * Record it, and tell the owner.
 *
 * DELIBERATELY DOES NOT CANCEL THE APPOINTMENT. A refund issued from the Stripe
 * dashboard is a decision about money, not about the diary — it can be a
 * goodwill gesture, a partial adjustment, or the tail end of a cancellation
 * that already happened here. Cancelling on its own initiative would delete a
 * booking the business may still be expecting to honour. So the row records the
 * money and the OWNER is told, which is the thing that actually needs to happen:
 * somebody has to decide whether the chair is still booked.
 */
async function onChargeRefunded(
  charge: Stripe.Charge,
): Promise<WebhookOutcome> {
  const paymentIntentId = idOf(charge.payment_intent);

  const [appointment] = paymentIntentId
    ? await db
        .select()
        .from(appointmentsTable)
        .where(eq(appointmentsTable.stripePaymentIntentId, paymentIntentId))
        .limit(1)
    : [];

  if (!appointment) {
    /* Either another application's charge — the shared-account case, and the
       overwhelmingly likely one — or a refund against a payment we never
       recorded. Only the second is worth a line in the log. */
    if (isOwnObject(charge.metadata)) {
      console.error(
        `[stripe] charge ${charge.id} is tagged ${OWNER_TAG} but its payment intent ` +
          `${paymentIntentId ?? "none"} matches no appointment.`,
      );

      return { status: "unresolved", detail: `charge ${charge.id}` };
    }

    return { status: "ignored", reason: "charge belongs to another application" };
  }

  /**
   * WAS THIS REFUND OURS?
   *
   * The slot-lost path refunds and stamps `refunded_at` before this event can
   * arrive. Alerting the owner about that would be telling them off for
   * something the product did on purpose, and they have already had the far
   * louder slot-lost log line. So an appointment that is already marked
   * refunded gets its amount brought up to date and nothing else.
   */
  const alreadyOurs = appointment.refundedAt !== null;

  await db.transaction(async (tx) => {
    await tx
      .update(appointmentsTable)
      .set({
        refundedAt: appointment.refundedAt ?? new Date(),
        refundedCents: charge.amount_refunded,
      })
      .where(eq(appointmentsTable.id, appointment.id));

    if (alreadyOurs) {
      return;
    }

    const [business] = await tx
      .select({ email: businesses.contactEmail, currency: businesses.currency })
      .from(businesses)
      .where(eq(businesses.id, appointment.businessId))
      .limit(1);

    if (business) {
      await tx.insert(notifications).values({
        appointmentId: appointment.id,
        kind: "refund",
        channel: "email",
        /* The BUSINESS, not the customer — Stripe already emails the customer
           a refund receipt, and the person who needs to decide what happens to
           the appointment is the owner. */
        toEmail: business.email,
        scheduledFor: new Date(),
        payload: {
          kind: "refund",
          refundedCents: charge.amount_refunded,
          currency: business.currency,
          full: charge.refunded,
          chargeId: charge.id,
        },
      });
    }
  });

  /* The owner's alert, on its way. Nothing was queued when the refund was
     ours, so this is a no-op on that path. */
  await dispatchDeliveries(db, appointment.id);

  return {
    status: "handled",
    detail: `recorded a ${charge.amount_refunded} cent refund on ${appointment.id}`,
  };
}

/* ===========================================================================
   Housekeeping
   =========================================================================== */

/**
 * Forget events older than a month.
 *
 * The guard only has to remember an event for as long as Stripe might retry it,
 * which is about three days. A month is generous and keeps the table from
 * growing without bound on a free tier. Called by the daily cron alongside the
 * hold janitor; nothing depends on it running.
 */
export async function forgetOldWebhookEvents(days = 30): Promise<number> {
  const deleted = await db
    .delete(webhookEvents)
    .where(
      sql`${webhookEvents.processedAt} < now() - make_interval(days => ${days}::int)`,
    )
    .returning({ id: webhookEvents.id });

  return deleted.length;
}
