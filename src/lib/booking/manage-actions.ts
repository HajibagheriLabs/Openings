import type { DayOffer, DayView } from "@/lib/scheduling/day-view";

/**
 * What the manage page's actions hand back.
 *
 * Shared vocabulary, no `server-only` — the client types its state with these
 * and the actions type their returns with them, so the two cannot drift.
 *
 * EVERY REFUSAL CARRIES A SENTENCE WRITTEN FOR A PERSON, and a code the client
 * routes on. There is no path here that surfaces an exception message to a
 * customer, and no path that says only "something went wrong".
 */

export type ManageRefusalCode =
  /** The link is not valid, or not valid any more. */
  | "unauthorized"
  /** Too many requests from this link or this address. */
  | "rate-limited"
  /** Policy says no — late, or the business does not allow it. */
  | "not-allowed"
  /** Somebody took the new time between the picker drawing it and the submit. */
  | "slot-taken"
  /** The time is no longer offered at all: hours changed, lead time caught up. */
  | "unavailable"
  /** Genuinely broke. The page keeps what it has and says so. */
  | "error";

export interface ManageRefusal {
  ok: false;
  code: ManageRefusalCode;
  message: string;
  /**
   * Nearest alternatives, when the reason was about a specific time.
   *
   * A refusal with an offer attached is the difference between a dead end and
   * a next step, and somebody who wanted Thursday at two wants something near
   * Thursday at two.
   */
  nearest?: DayOffer[];
  /** A fresh drawing of the day, so a lost race redraws the truth immediately. */
  day?: DayView;
}

export type RescheduleResult =
  | {
      ok: true;
      /** ISO instants of where it landed. */
      startsAt: string;
      endsAt: string;
      /**
       * False when the appointment was already on that instant — a double
       * submit. Nothing was written, nothing was emailed, and the page says
       * the same thing either way.
       */
      changed: boolean;
    }
  | ManageRefusal;

export type CancelResult =
  | {
      ok: true;
      /**
       * What went back to the card, in integer cents. Zero covers both "no
       * deposit" and "the policy keeps it" — the page already told them which
       * before they pressed the button.
       */
      refundedCents: number;
      /** False when it was already cancelled. No second refund was attempted. */
      changed: boolean;
    }
  | ManageRefusal;

export type RescheduleDayResult =
  | { ok: true; day: DayView }
  | ManageRefusal;
