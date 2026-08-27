"use server";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { appointments, businesses } from "@/db/schema";
import type {
  BookingPaymentState,
  StartCheckoutResult,
} from "@/lib/booking/checkout";
import { CHECKOUT_SESSION_PATTERN } from "@/lib/booking/url";
import { readOwnAppointment } from "@/lib/scheduling/booking";
import { BROKE_MESSAGE, handOffToStripe } from "@/server/booking/checkout";
import { loadDetailsContext } from "@/server/booking/details";
import {
  CONFIRMED_COOKIE_SECONDS,
  readHoldCookie,
  writeHoldCookie,
} from "@/server/booking/hold-cookie";

/**
 * The two things the payment step asks the server.
 *
 * Both are PUBLIC, UNAUTHENTICATED endpoints — customers book as guests — so
 * neither takes an appointment id. What identifies the booking is the hold
 * cookie this browser is carrying, or the Stripe session id Stripe handed it
 * on the way back. Nothing a caller can invent names somebody else's booking.
 */

const slugSchema = z.object({ slug: z.string().min(1).max(64) });

const pollSchema = slugSchema.extend({
  /** The session Stripe redirected with. Shape-checked; resolved against rows. */
  sessionId: z.string().regex(CHECKOUT_SESSION_PATTERN).nullish(),
});

/* ===========================================================================
   Hand off to Stripe
   =========================================================================== */

/**
 * Create (or reopen) the Checkout Session for this browser's hold.
 *
 * EVERY CHECK RUNS AGAIN. `loadDetailsContext` is the same resolution the
 * details form and its submit use: the hold is live and this browser's, and
 * the service and staff member are still active. Time passes between saving
 * details and pressing pay, and a dead hold must not become a live payment.
 *
 * Called on the details step's submit and again by the retry button, so it has
 * to be safe to call twice — which is why `startCheckout` reuses an open
 * session rather than creating a second one.
 */
export async function beginCheckout(
  input: z.input<typeof slugSchema>,
): Promise<StartCheckoutResult> {
  const parsed = slugSchema.safeParse(input);

  if (!parsed.success) {
    return { ok: false, reason: "error", message: BROKE_MESSAGE };
  }

  const now = new Date();
  const loaded = await loadDetailsContext(parsed.data.slug, now);

  if (!loaded.ok) {
    return { ok: false, reason: "policy", refusal: loaded.refusal };
  }

  return handOffToStripe(loaded.context.hold.id, now);
}

/* ===========================================================================
   Is it booked yet?
   =========================================================================== */

/**
 * What the confirming screen polls.
 *
 * THE REDIRECT IS NOT PROOF OF PAYMENT. This reports the status of a row, and
 * that row is only flipped to `confirmed` by the verified Stripe webhook. A
 * customer standing on the success page with money already gone from their
 * account still gets `pending` here until the signed event lands, and that is
 * correct — anything else would be this application taking a browser's word
 * for a payment.
 *
 * TWO WAYS TO NAME THE BOOKING, and the second one matters. The hold cookie
 * lives about as long as the hold; somebody who spent five minutes on Stripe's
 * page can come back without it. The session id Stripe put in the return URL
 * is unguessable, was handed to this browser, and names exactly one
 * appointment — so it resolves the booking when the cookie no longer can.
 */
export async function checkPaymentState(
  input: z.input<typeof pollSchema>,
): Promise<BookingPaymentState> {
  const parsed = pollSchema.safeParse(input);

  if (!parsed.success) {
    return { state: "gone" };
  }

  const { slug, sessionId } = parsed.data;

  const cookie = await readHoldCookie(slug);

  if (cookie) {
    const appointment = await readOwnAppointment(
      db,
      cookie.appointmentId,
      cookie.manageToken,
    );

    if (appointment?.status === "confirmed") {
      /**
       * The cookie changes meaning here, so it changes lifetime here.
       *
       * It stops being "the slot I am holding for eight minutes" and becomes
       * "the appointment this browser just made" — and without the extension
       * it would lapse minutes later, taking the confirmation screen with it.
       */
      await writeHoldCookie(cookie, CONFIRMED_COOKIE_SECONDS);

      return { state: "confirmed" };
    }

    if (appointment?.status === "held") {
      return { state: "pending" };
    }
  }

  if (sessionId) {
    const status = await statusForSession(slug, sessionId);

    if (status) {
      return status;
    }
  }

  return { state: "gone" };
}

/**
 * The appointment a Stripe session paid for, scoped to this business.
 *
 * The session id is the credential: Stripe generated it, handed it to this
 * browser, and it names one row. It is not enough to manage or cancel
 * anything — only to be told whether the booking it belongs to is through yet.
 */
async function statusForSession(
  slug: string,
  sessionId: string,
): Promise<BookingPaymentState | null> {
  const [row] = await db
    .select({ status: appointments.status })
    .from(appointments)
    .innerJoin(businesses, eq(businesses.id, appointments.businessId))
    .where(
      and(
        eq(appointments.stripeCheckoutSessionId, sessionId),
        eq(businesses.slug, slug),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }

  if (row.status === "confirmed") {
    return { state: "confirmed" };
  }

  return row.status === "held" ? { state: "pending" } : { state: "gone" };
}
