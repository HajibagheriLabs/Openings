import type { DayOffer, DayView } from "@/lib/scheduling/day-view";

/**
 * The contract between the picker and the server, and the two numbers the
 * browser is allowed to know about time.
 *
 * NO `server-only` HERE. This is the shared vocabulary — the client imports
 * the types to type its state, the actions import them to type their returns,
 * and neither can drift from the other. The hold's LENGTH is deliberately not
 * in this file: it lives in `DEFAULT_HOLD_MINUTES` in the booking module and
 * reaches the browser only as an `expiresAt` instant, so there is exactly one
 * place to change it and no chance of the countdown and the database
 * disagreeing about when eight minutes are up.
 */

/** A live hold, as the browser sees it. */
export interface HoldSnapshot {
  appointmentId: string;
  /** Customer-facing start and end. */
  startsAt: string;
  endsAt: string;
  /** ISO instant the DATABASE says this expires. The countdown runs to this. */
  expiresAt: string;
  /**
   * ISO instant the hold was taken, from the same clock as `expiresAt`.
   *
   * The depleting bar needs a full-scale, and computing it from a constant the
   * client was told separately would let the bar and the clock disagree the
   * moment the hold length changed. Two instants from one server, and the bar
   * is `remaining / (expiresAt - takenAt)`.
   */
  takenAt: string;
  /** The server's clock at the moment of the response — see `useHoldClock`. */
  serverNow: string;
}

/** Everything the picker redraws itself from, after any server round trip. */
export interface PickerSnapshot {
  day: DayView;
  hold: HoldSnapshot | null;
}

export type TakeSlotResult =
  | { ok: true; snapshot: PickerSnapshot }
  /**
   * Somebody else got it. Carries a FRESH day and the nearest alternatives, so
   * the picker can redraw the truth and make an offer in the same breath
   * instead of showing an error and leaving the customer to hunt.
   */
  | {
      ok: false;
      reason: "taken";
      message: string;
      snapshot: PickerSnapshot;
      nearest: DayOffer[];
    }
  /**
   * The time is no longer offered at all — somebody booked it a moment ago,
   * the hours changed, the lead time caught up. It carries alternatives for
   * the same reason a lost race does: whatever the cause, the customer wanted
   * a time near that one and is owed the nearest ones going.
   */
  | {
      ok: false;
      reason: "gone";
      message: string;
      snapshot: PickerSnapshot;
      nearest: DayOffer[];
    }
  /** Something genuinely broke. The picker keeps what it has and says so. */
  | { ok: false; reason: "error"; message: string };

export type ReleaseSlotResult =
  | { ok: true; snapshot: PickerSnapshot }
  | { ok: false; reason: "error"; message: string };

export type RefreshDayResult =
  | { ok: true; snapshot: PickerSnapshot }
  | { ok: false; reason: "error"; message: string };

/**
 * When the countdown stops being background and starts being a warning.
 *
 * A minute is enough to finish typing an email address and not enough to go
 * and make tea, which is exactly the decision the warning is asking the
 * customer to make.
 */
export const HOLD_WARNING_SECONDS = 60;

/**
 * How often the picker re-asks the server what the day looks like.
 *
 * WHY POLLING AND NOT A WEBSOCKET — and this is the load-bearing comment.
 *
 * A socket is one long-lived connection PER VISITOR. On Vercel's serverless
 * runtime that means a function instance held open for as long as somebody is
 * looking at a calendar, billed by the second, for a page whose median session
 * is under two minutes. Fifty people browsing a Saturday is fifty pinned
 * instances doing nothing. A poll is fifty short requests every fifteen
 * seconds against a query that already costs five statements for a whole
 * month, and it costs nothing at all while nobody is looking.
 *
 * But the real argument is not cost. IT IS THAT THE SOCKET WOULD NOT BE DOING
 * THE JOB PEOPLE ASSUME IT DOES. Live updates do not protect a customer's
 * slot; they only tell them faster that it went. What actually protects the
 * slot is the HOLD — a real `held` row that the exclusion constraint enforces
 * from the instant they tap. Once that exists, being told about someone else's
 * booking within fifteen seconds instead of within fifteen milliseconds
 * changes nothing that can be lost, because the thing worth losing is already
 * reserved in Postgres.
 *
 * So polling is not a cheap approximation of the right answer here. The hold
 * is the right answer, and the poll is a courtesy on top of it: it keeps the
 * drawing honest for somebody who has not chosen yet. That is worth fifteen
 * seconds of staleness and not worth a persistent connection.
 */
export const POLL_INTERVAL_MS = 15_000;

/**
 * How long a hidden tab waits before giving up on polling entirely.
 *
 * Zero, in effect: `visibilitychange` stops the timer outright and a refresh
 * fires on the way back. A backgrounded tab has no viewer, so every request it
 * makes is spent on a drawing nobody is looking at.
 */
export const POLL_WHEN_HIDDEN = false;
