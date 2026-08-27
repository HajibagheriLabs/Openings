import type Stripe from "stripe";

import {
  formatInstant,
  formatInstantDate,
  formatTimeZoneAbbreviation,
} from "@/components/time-text";
import { formatCents } from "@/lib/money";

/**
 * What a Checkout Session for a deposit looks like — worked out as a pure
 * function, so every rule in it is testable without a network call.
 *
 * NOTHING HERE READS THE CLIENT. The amount comes from the appointment row,
 * which snapshotted the deposit when the hold was written; the time and the
 * staff member come from the same row. A browser that posts `{ amount: 1 }`
 * changes nothing, because there is no parameter for it to change.
 *
 * The one genuinely surprising rule is `checkoutExpiresAt` — see the long note
 * on it. Stripe's minimum session lifetime is longer than this product's hold,
 * so "expire the session with the hold" cannot be expressed as `expires_at`
 * alone and is enforced from our side instead.
 */

/* ===========================================================================
   Whose payment is this?
   =========================================================================== */

/**
 * The metadata key that says this object belongs to Openings.
 *
 * WHY IT EXISTS: a Stripe test-mode account is per-developer, not per-project,
 * so the same account is very likely serving more than one application. And
 * `stripe listen` forwards EVERY event on the account to whatever endpoint it
 * is pointed at — including events from a completely different app. Without a
 * marker, this project's webhook would try to resolve another project's
 * checkout session against `appointments`, find nothing, and log a poison
 * event on every unrelated payment.
 *
 * So every object this app creates is tagged, and the webhook (prompt 13)
 * ignores anything untagged instead of treating it as an error. It costs one
 * key and removes a whole class of confusing local failure.
 */
export const OWNER_TAG = "openings" as const;

/** Metadata keys, in one place so the writer and the webhook cannot drift. */
export const CHECKOUT_METADATA = {
  /** Always `OWNER_TAG`. See above. */
  app: "app",
  appointmentId: "appointment_id",
  businessId: "business_id",
  /** The appointment's start, for a human reading the Stripe dashboard. */
  startsAt: "starts_at",
} as const;

/** Whether a Stripe object came from this application. */
export function isOwnObject(
  metadata: Stripe.Metadata | null | undefined,
): boolean {
  return metadata?.[CHECKOUT_METADATA.app] === OWNER_TAG;
}

/* ===========================================================================
   Session lifetime
   =========================================================================== */

/**
 * Stripe's floor for `expires_at`: a session may not be set to expire less
 * than 30 minutes after it is created. Ours is deliberately not a guess — it
 * is the documented minimum, and passing anything smaller is a 400.
 */
export const STRIPE_MIN_SESSION_MINUTES = 30;

/** Stripe's ceiling for `expires_at`, and the default when it is omitted. */
export const STRIPE_MAX_SESSION_HOURS = 24;

/**
 * When the Checkout Session should die.
 *
 * THE INTENT IS "THE SESSION DIES WITH THE HOLD", AND STRIPE WILL NOT DO IT.
 * A hold lasts eight minutes; `expires_at` cannot be less than thirty. So the
 * intent is honoured in three places instead of one, and this function is only
 * the last of them:
 *
 *   1. Returning through `cancel_url` releases the hold AND expires the
 *      session immediately, which is the path most abandonments actually take.
 *   2. The hold expires on the database's clock regardless, and every
 *      availability query and booking transaction already treats it as gone.
 *      A session outliving its hold cannot hold a slot, because the slot was
 *      never the session's to hold.
 *   3. This, thirty minutes out, so an abandoned session stops being payable
 *      reasonably soon and `checkout.session.expired` arrives to tidy up.
 *
 * What is NOT acceptable is a session that outlives its hold by hours and then
 * gets paid — that is the "hold expired before payment landed" case, and the
 * webhook handles it explicitly by re-acquiring the slot or refunding. Keeping
 * the window at the minimum makes that case rare instead of routine.
 *
 * Returns epoch SECONDS, which is what Stripe takes.
 */
export function checkoutExpiresAt(now: Date): number {
  return Math.floor(now.getTime() / 1000) + STRIPE_MIN_SESSION_MINUTES * 60;
}

/* ===========================================================================
   Capture method
   =========================================================================== */

/**
 * How far ahead an appointment may be for a manual-capture authorization to be
 * safe.
 *
 * Stripe cancels an uncaptured PaymentIntent after ROUGHLY SEVEN DAYS. Six is
 * that number with a day of margin, because "roughly" is doing real work in
 * that sentence and an appointment sitting exactly on the boundary should not
 * be a coin flip between a live authorization and a silently dead one.
 */
export const MANUAL_CAPTURE_HORIZON_DAYS = 6;

/**
 * Immediate capture, unless the business asked for otherwise AND the
 * appointment is close enough for an authorization to survive until it.
 *
 * WHY IMMEDIATE IS THE DEFAULT, AND WHY THE SETTING IS OFF:
 * a manual-capture authorization is not a hold that waits patiently. Stripe
 * cancels an uncaptured PaymentIntent after about seven days, so for anything
 * booked further out than a week the "hold" on the customer's card quietly
 * dies before the appointment — the money is never taken, the business never
 * finds out, and the first anybody knows about it is an empty chair. Charging
 * the deposit at booking has none of that failure mode: it either succeeds now
 * or the booking is not confirmed now, and a refund is a first-class operation
 * with a webhook behind it.
 *
 * Manual capture is offered only for an appointment INSIDE that window, and
 * only when the owner has turned it on. Both conditions, every time.
 */
export function chooseCaptureMethod(input: {
  startsAt: Date;
  now: Date;
  /** `businesses.manual_capture_enabled`. Off by default. */
  manualCaptureEnabled: boolean;
}): "automatic" | "manual" {
  if (!input.manualCaptureEnabled) {
    return "automatic";
  }

  const horizonMs = MANUAL_CAPTURE_HORIZON_DAYS * 24 * 60 * 60 * 1000;
  const withinWindow =
    input.startsAt.getTime() - input.now.getTime() <= horizonMs;

  return withinWindow ? "manual" : "automatic";
}

/* ===========================================================================
   The line item, in the customer's words
   =========================================================================== */

export interface CheckoutAppointment {
  id: string;
  businessId: string;
  /** ISO instants. Customer-facing, not the blocking range. */
  startsAt: string;
  endsAt: string;
  serviceName: string;
  durationMin: number;
  staffName: string;
  /** ISO 4217, as stored on the business. Lowercased for Stripe below. */
  currency: string;
  priceCents: number;
  /** Snapshotted on the appointment row. What is charged now. */
  depositCents: number;
  customerEmail: string;
  /** The business's IANA zone. Every time on the Stripe page is stated in it. */
  timeZone: string;
  businessName: string;
}

/**
 * What the customer reads on Stripe's page.
 *
 * They arrive here from a booking flow and they are about to see an unfamiliar
 * domain asking for a card, so the line item repeats the booking back to them:
 * the service, the person, the day, the time, and its timezone. "Deposit —
 * £15.00" with no context is how a payment gets abandoned or, worse, disputed
 * three weeks later by somebody who genuinely did not recognise it.
 */
export function describeDepositLineItem(
  appointment: CheckoutAppointment,
): { name: string; description: string } {
  const balanceCents = Math.max(
    appointment.priceCents - appointment.depositCents,
    0,
  );

  const day = formatInstantDate(appointment.startsAt, appointment.timeZone);
  const time = formatInstant(appointment.startsAt, appointment.timeZone);
  const zone = formatTimeZoneAbbreviation(
    appointment.startsAt,
    appointment.timeZone,
  );

  const when = `${day} at ${time} ${zone}`;

  /* A deposit that IS the price is not a deposit, it is the bill — and calling
     it a deposit would leave somebody expecting a second charge on the day. */
  const name =
    balanceCents > 0
      ? `Deposit — ${appointment.serviceName}`
      : appointment.serviceName;

  const balanceSentence =
    balanceCents > 0
      ? ` The remaining ${formatCents(
          balanceCents,
          appointment.currency,
        )} is due on the day.`
      : " Nothing further to pay on the day.";

  return {
    name,
    description:
      `${when}, with ${appointment.staffName} at ${appointment.businessName}.` +
      balanceSentence,
  };
}

/* ===========================================================================
   The session
   =========================================================================== */

export interface CheckoutSessionInput {
  appointment: CheckoutAppointment;
  /** Where Stripe sends them after paying. Carries the session id template. */
  successUrl: string;
  /** Where "back" goes. A route that releases the hold — never a page. */
  cancelUrl: string;
  now: Date;
  manualCaptureEnabled: boolean;
}

/**
 * Every field of the Checkout Session, and why it is there.
 *
 * Pure on purpose: the whole point of the rules above is that they are
 * checkable, and a function that also performs a network call cannot be
 * checked cheaply. `createCheckoutSession` in src/server/payments does the
 * talking.
 */
export function buildCheckoutSessionParams(
  input: CheckoutSessionInput,
): Stripe.Checkout.SessionCreateParams {
  const { appointment } = input;

  if (appointment.depositCents <= 0) {
    /* Not a validation nicety: Checkout refuses a zero-amount payment session,
       and a booking with nothing to pay should never have reached here. The
       free path confirms at the details step — see submitDetails. */
    throw new Error(
      `Appointment ${appointment.id} has no deposit to collect.`,
    );
  }

  const { name, description } = describeDepositLineItem(appointment);

  const captureMethod = chooseCaptureMethod({
    startsAt: new Date(appointment.startsAt),
    now: input.now,
    manualCaptureEnabled: input.manualCaptureEnabled,
  });

  /**
   * THE SAME FACTS TWICE, DELIBERATELY.
   *
   * `client_reference_id` is the field Stripe surfaces in the dashboard and in
   * the event payload without any expansion, and metadata is what survives
   * onto the PaymentIntent and the Charge. The webhook reads metadata; a human
   * looking at a payment reads the reference. Writing the appointment id into
   * both costs nothing and means neither reader has to go looking.
   */
  const metadata: Stripe.MetadataParam = {
    [CHECKOUT_METADATA.app]: OWNER_TAG,
    [CHECKOUT_METADATA.appointmentId]: appointment.id,
    [CHECKOUT_METADATA.businessId]: appointment.businessId,
    [CHECKOUT_METADATA.startsAt]: appointment.startsAt,
  };

  return {
    mode: "payment",
    client_reference_id: appointment.id,
    metadata,

    /* Pre-filled, and not editable to something else: the confirmation, the
       calendar invite and the manage link all go to the address they typed on
       the details step, and a second address on the receipt would split one
       booking across two inboxes. */
    customer_email: appointment.customerEmail,

    line_items: [
      {
        quantity: 1,
        price_data: {
          /* Stripe wants a lowercase ISO code; the business row stores "EUR". */
          currency: appointment.currency.toLowerCase(),
          unit_amount: appointment.depositCents,
          product_data: { name, description },
        },
      },
    ],

    payment_intent_data: {
      /**
       * IMMEDIATE CAPTURE IS THE DEFAULT AND THE REASON IS NOT STYLISTIC:
       * Stripe cancels an uncaptured PaymentIntent after roughly seven days,
       * so a manual-capture authorization on an appointment booked further out
       * than a week silently dies before the appointment happens. The money is
       * never taken and nobody is told. See `chooseCaptureMethod`, which is
       * the only thing allowed to return "manual", and only for an appointment
       * inside that window at a business that opted in.
       */
      capture_method: captureMethod,
      /* Shown on the payment in the dashboard, so a business owner scanning
         their payments sees a booking rather than an id. */
      description: `${name} · ${appointment.businessName}`,
      /* Metadata does not flow from a session to its PaymentIntent on its own,
         and `charge.refunded` arrives carrying the charge — not the session. */
      metadata,
    },

    success_url: input.successUrl,
    cancel_url: input.cancelUrl,

    /* See the long note on `checkoutExpiresAt`: Stripe's floor is thirty
       minutes, which is longer than a hold, so this is a backstop rather than
       the mechanism. The cancel route and the hold's own deadline are. */
    expires_at: checkoutExpiresAt(input.now),

    /* The button says "Book" rather than the default "Pay". This is the last
       step of a booking, not a shop checkout, and the word the customer is
       looking for is the one they started with. */
    submit_type: "book",
  };
}
