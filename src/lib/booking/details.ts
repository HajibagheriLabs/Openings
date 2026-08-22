import type { PolicyRefusal } from "@/lib/booking/policy";
import type { BookingDetailsField } from "@/lib/validation/booking-details";

/**
 * What the details step is handed, and what it gets back.
 *
 * Shared vocabulary, no `server-only` — the action types its return with these
 * and the form types its props with them, so the two cannot drift.
 */

/**
 * Everything the summary panel states, resolved on the server.
 *
 * MONEY IS THREE NUMBERS, NOT ONE. "£48.50" answers a question nobody asked.
 * What somebody about to give a business their card wants to know is what
 * leaves their account now, what they bring on the day, and what the two add
 * up to — so all three are computed once, on the server, in integer cents, and
 * the client only formats them.
 */
export interface BookingSummary {
  serviceName: string;
  /** The person who will do it. Resolved when the hold was taken, never "any". */
  staffName: string;
  /** Customer-facing instants. The client formats these and nothing else. */
  startsAt: string;
  endsAt: string;
  timeZone: string;
  durationMin: number;
  currency: string;
  /** The full price of the service. */
  priceCents: number;
  /** Charged now. Zero means there is no payment step at all. */
  depositCents: number;
  /** Owed at the appointment. `priceCents - depositCents`. */
  balanceCents: number;
  /** The cancellation policy in plain sentences, as the consent box covers it. */
  policyLines: string[];
}

/** The appointment as the confirmation screen states it. */
export interface ConfirmedBooking {
  appointmentId: string;
  summary: BookingSummary;
  /** Where the confirmation was sent. Shown so a typo is obvious immediately. */
  email: string;
}

export type SubmitDetailsResult =
  /** Nothing was owed, so the booking is done. */
  | { ok: true; outcome: "confirmed" }
  /**
   * The details are saved against the hold and a deposit is due.
   *
   * The appointment stays `held` — the slot is still reserved, the countdown
   * still runs — and payment is the next step. Confirmation happens only in
   * the verified Stripe webhook, never on a redirect.
   */
  | { ok: true; outcome: "payment-required"; depositCents: number }
  /** The form itself. Field-level, so the message lands under the input. */
  | {
      ok: false;
      reason: "invalid";
      fieldErrors: Partial<Record<BookingDetailsField, string>>;
    }
  /** A rule said no. Carries what happened and what to do about it. */
  | { ok: false; reason: "policy"; refusal: PolicyRefusal }
  /** Something genuinely broke. Never an exception string. */
  | { ok: false; reason: "error"; message: string };
