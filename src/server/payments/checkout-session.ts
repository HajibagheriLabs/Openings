import "server-only";

import { eq } from "drizzle-orm";
import type Stripe from "stripe";

import { db } from "@/db";
import {
  appointments as appointmentsTable,
  businesses,
  customers,
  services,
  staff,
} from "@/db/schema";
import { clientEnv } from "@/env";
import { bookingUrl } from "@/lib/booking/url";
import {
  buildCheckoutSessionParams,
  type CheckoutAppointment,
} from "@/lib/payments/checkout";
import { getStripe } from "@/lib/payments/stripe";
import { localDateOf } from "@/server/booking/picker";

/**
 * Handing a held appointment to Stripe.
 *
 * THE AMOUNT IS NEVER AN ARGUMENT. Every field of the session is read from the
 * appointment row and the rows it points at — the deposit that was snapshotted
 * when the hold was written, the service, the person, the time, the email the
 * customer typed on the details step. There is no parameter through which a
 * browser could name a price, so there is nothing to tamper with.
 *
 * The session id is written back onto the appointment, which is what makes
 * pressing the button twice cheap: the second press finds an open session and
 * returns the same URL instead of stacking up abandoned ones.
 */

/** The appointment, the business's settings, and the return addresses. */
export interface CheckoutTarget {
  appointment: CheckoutAppointment;
  slug: string;
  manualCaptureEnabled: boolean;
  /** The session already on the row, if any. */
  existingSessionId: string | null;
  /**
   * The answers that would put a visitor back on this appointment's own day.
   *
   * Kept as the three choices rather than a finished URL so the caller can add
   * its own — the cancel route needs a `notice` on the end, and stitching that
   * onto a string is how a `?` ends up doubled.
   */
  picker: { serviceId: string; staffId: string; date: string };
}

/**
 * Everything a Checkout Session needs, in one query.
 *
 * Deliberately reads the APPOINTMENT rather than the service: `price_cents`
 * and `deposit_cents` on the row were snapshotted at the moment the slot was
 * taken, so an owner who edits their prices while somebody is filling in the
 * form cannot change what that person is charged. The service is joined only
 * for its name and length, which are description, not money.
 */
export async function loadCheckoutTarget(
  appointmentId: string,
): Promise<CheckoutTarget | null> {
  const [row] = await db
    .select({
      id: appointmentsTable.id,
      businessId: appointmentsTable.businessId,
      startsAt: appointmentsTable.startsAt,
      endsAt: appointmentsTable.endsAt,
      priceCents: appointmentsTable.priceCents,
      depositCents: appointmentsTable.depositCents,
      serviceId: appointmentsTable.serviceId,
      staffId: appointmentsTable.staffId,
      existingSessionId: appointmentsTable.stripeCheckoutSessionId,
      serviceName: services.name,
      durationMin: services.durationMin,
      staffName: staff.name,
      customerEmail: customers.email,
      businessName: businesses.name,
      slug: businesses.slug,
      timezone: businesses.timezone,
      currency: businesses.currency,
      manualCaptureEnabled: businesses.manualCaptureEnabled,
    })
    .from(appointmentsTable)
    .innerJoin(services, eq(services.id, appointmentsTable.serviceId))
    .innerJoin(staff, eq(staff.id, appointmentsTable.staffId))
    /* An INNER join on the customer is the check that the details step
       actually happened: a bare hold has no customer, and there is nobody to
       pre-fill an email for or send a receipt to. */
    .innerJoin(customers, eq(customers.id, appointmentsTable.customerId))
    .innerJoin(businesses, eq(businesses.id, appointmentsTable.businessId))
    .where(eq(appointmentsTable.id, appointmentId))
    .limit(1);

  if (!row) {
    return null;
  }

  return {
    slug: row.slug,
    manualCaptureEnabled: row.manualCaptureEnabled,
    existingSessionId: row.existingSessionId,
    picker: {
      serviceId: row.serviceId,
      staffId: row.staffId,
      date: localDateOf(row.startsAt.toISOString(), row.timezone),
    },
    appointment: {
      id: row.id,
      businessId: row.businessId,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      serviceName: row.serviceName,
      durationMin: row.durationMin,
      staffName: row.staffName,
      currency: row.currency,
      priceCents: row.priceCents,
      depositCents: row.depositCents,
      customerEmail: row.customerEmail,
      timeZone: row.timezone,
      businessName: row.businessName,
    },
  };
}

export type CheckoutHandoff =
  | { ok: true; url: string }
  /** The session is already paid. The webhook confirms; this screen waits. */
  | { ok: true; url: null; alreadyPaid: true }
  | { ok: false; reason: "not-configured" }
  | { ok: false; reason: "no-deposit" };

/**
 * The URL to send the customer to, creating the session if there isn't one.
 *
 * REUSE BEFORE CREATE. A customer who presses back on Stripe's page and then
 * presses "Pay" again should land on the same session, not a second one — two
 * open sessions for one appointment means two ways to pay for a slot that can
 * only be sold once, and the second `checkout.session.expired` would try to
 * release a hold that the first had already turned into a booking.
 */
export async function startCheckout(
  target: CheckoutTarget,
  now: Date = new Date(),
): Promise<CheckoutHandoff> {
  const stripe = getStripe();

  if (!stripe) {
    return { ok: false, reason: "not-configured" };
  }

  if (target.appointment.depositCents <= 0) {
    return { ok: false, reason: "no-deposit" };
  }

  if (target.existingSessionId) {
    const existing = await retrieveSession(stripe, target.existingSessionId);

    /* Open and payable: the same URL, so a second press is a second look at
       the same page rather than a second way to pay. */
    if (existing?.status === "open" && existing.url) {
      return { ok: true, url: existing.url };
    }

    /* Already paid. The webhook owns confirmation, so there is nothing to do
       here but stop and let the confirming screen wait for it. */
    if (existing?.status === "complete") {
      return { ok: true, url: null, alreadyPaid: true };
    }

    /* Expired, or belongs to keys we no longer hold. Fall through and make a
       new one — the appointment is still held and still owed a deposit. */
  }

  const params = buildCheckoutSessionParams({
    appointment: target.appointment,
    successUrl: successUrl(target),
    cancelUrl: cancelUrl(target.slug),
    now,
    manualCaptureEnabled: target.manualCaptureEnabled,
  });

  /**
   * NO EXPLICIT IDEMPOTENCY KEY, and that is deliberate.
   *
   * The SDK attaches one per request for its OWN network retries, which is the
   * duplicate this call can actually produce. An appointment-scoped key would
   * be worse than nothing: Stripe remembers a key for 24 hours and replays the
   * original response, so once a session expired, every attempt to make a new
   * one for that appointment would hand back the dead session forever. The
   * reuse-before-create branch above is what prevents duplicates at the level
   * that matters.
   */
  const session = await stripe.checkout.sessions.create(params);

  if (!session.url) {
    throw new Error(
      `Stripe returned a session with no URL for appointment ${target.appointment.id}.`,
    );
  }

  /* Written back so the next press reuses it, so the cancel route can expire
     it, and so the webhook can be matched to an appointment even if metadata
     is ever lost. */
  await db
    .update(appointmentsTable)
    .set({ stripeCheckoutSessionId: session.id })
    .where(eq(appointmentsTable.id, target.appointment.id));

  return { ok: true, url: session.url };
}

/**
 * Kill an open session.
 *
 * Called when the customer comes back through `cancel_url`, so an abandoned
 * session dies with the hold it was taking payment for rather than sitting
 * payable for another half hour. Best effort: a session that is already
 * expired or already complete simply cannot be expired, and that is not a
 * failure worth surfacing to somebody who has left.
 */
export async function expireCheckoutSession(
  sessionId: string,
): Promise<void> {
  const stripe = getStripe();

  if (!stripe) {
    return;
  }

  try {
    await stripe.checkout.sessions.expire(sessionId);
  } catch {
    // Already expired, already paid, or unknown to these keys. Nothing to do.
  }
}

/** Retrieve, treating "no such session" as "no session". */
async function retrieveSession(
  stripe: Stripe,
  sessionId: string,
): Promise<Stripe.Checkout.Session | null> {
  try {
    return await stripe.checkout.sessions.retrieve(sessionId);
  } catch {
    return null;
  }
}

/**
 * Where Stripe sends the customer after they pay.
 *
 * `{CHECKOUT_SESSION_ID}` is a template Stripe substitutes, and it is appended
 * RAW rather than through URLSearchParams — the encoder would percent-escape
 * the braces and Stripe would hand back a literal `%7BCHECKOUT_SESSION_ID%7D`.
 */
function successUrl(target: CheckoutTarget): string {
  const path = bookingUrl(target.slug, { step: "confirming" });
  const join = path.includes("?") ? "&" : "?";

  return `${origin()}${path}${join}session={CHECKOUT_SESSION_ID}`;
}

/**
 * Where "back" goes: a route handler, never a page.
 *
 * Returning from an abandoned checkout has to RELEASE the hold, and a page
 * render must not write. The route takes no return address — it rebuilds the
 * picker's URL from the appointment itself, which is one fewer parameter to
 * validate and no way to turn this into an open redirect.
 */
function cancelUrl(slug: string): string {
  return `${origin()}/api/book/checkout/cancel?slug=${encodeURIComponent(slug)}`;
}

/**
 * Stripe needs absolute URLs, and it needs them to be the ones the customer
 * came from. NEXT_PUBLIC_APP_URL is that origin in every environment.
 */
function origin(): string {
  return clientEnv.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
}
