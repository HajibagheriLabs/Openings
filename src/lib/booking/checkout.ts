import type { PolicyRefusal } from "@/lib/booking/policy";

/**
 * The vocabulary of the payment step, shared by the server and the browser.
 *
 * No `server-only` — the actions type their returns with these and the client
 * types its state with them, so the two cannot drift. Nothing here talks to
 * Stripe; it only names the outcomes.
 */

/** Handing the customer over to Stripe, or saying why not. */
export type StartCheckoutResult =
  /** Go here. A full Stripe-hosted URL; the browser navigates to it. */
  | { ok: true; url: string }
  /**
   * The payment already landed and the webhook is (or soon will be) confirming
   * it. Not a failure — somebody pressed the button twice, or came back to a
   * tab. The right answer is the confirming screen, not a second session.
   */
  | { ok: true; url: null; alreadyPaid: true }
  /** A rule said no — usually the hold. Carries what to do about it. */
  | { ok: false; reason: "policy"; refusal: PolicyRefusal }
  /** Something genuinely broke, or Stripe is not configured. Never an exception string. */
  | { ok: false; reason: "error"; message: string };

/**
 * What the confirming screen is waiting on.
 *
 * THE REDIRECT IS NOT PROOF OF PAYMENT — this is the type that exists because
 * of it. Between Stripe sending the customer back and the signed webhook
 * arriving, the appointment is still `held` and the honest answer is "not yet".
 */
export type BookingPaymentState =
  /** The webhook has landed and the appointment is booked. */
  | { state: "confirmed" }
  /** Still held. The payment may be through; nothing has confirmed it here. */
  | { state: "pending" }
  /**
   * There is no appointment to report on — the hold was swept, the row was
   * released, or this browser is carrying nothing that names a booking.
   *
   * NOT necessarily a failed payment. If money was taken for a slot that had
   * gone, the webhook refunds it and emails; this screen's job is to stop
   * spinning and say what happens next.
   */
  | { state: "gone" };

/**
 * How long the confirming screen keeps asking before it stops.
 *
 * A local `stripe listen` forwards in well under a second; production webhooks
 * are typically a second or two. Ninety seconds is far beyond either, and the
 * point of the limit is not to give up on the booking — the booking is fine —
 * but to stop showing a spinner to somebody whose confirmation is going to
 * arrive by email either way.
 */
export const CONFIRMING_TIMEOUT_MS = 90_000;

/** How often to ask. Quick at first, because the usual answer arrives at once. */
export const CONFIRMING_POLL_MS = 2_000;
