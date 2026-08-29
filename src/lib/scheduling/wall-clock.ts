import "server-only";

import { Temporal, type TimeZoneId } from "./temporal";

/**
 * A local date and a local time, from a form, into a real instant.
 *
 * ═══ THE TWO DAYS A YEAR THIS IS NOT A CONVERSION ═══
 *
 * Everywhere else in this product a wall-clock time is resolved with
 * `disambiguation: "compatible"`, which quietly picks an answer and moves on.
 * That is right for expanding a recurring rule — "we open at nine" has to mean
 * something on all 365 days, and a business that threw an exception once a year
 * would be a broken business.
 *
 * IT IS WRONG FOR A TIME SOMEBODY JUST TYPED. When an owner writes 02:30 on the
 * morning the clocks go forward, that minute does not exist: there is no
 * instant it names. "Compatible" would silently book them at 03:30, and they
 * would find out when the customer arrived an hour after they expected. So this
 * function REFUSES, and says why in words the person can act on.
 *
 * Fall-back is the opposite case and gets the opposite treatment. 02:30 happens
 * TWICE that morning, so the time is not impossible, only ambiguous — the
 * earlier of the two is taken (the appointment the customer would say they
 * booked) and the caller is told, so the confirmation can be explicit about
 * which one it is. Refusing a time that does exist would be pedantry.
 */

export type WallClockResolution =
  | { ok: true; instant: Date; ambiguous: boolean }
  /** The local time does not exist on that date — the clocks went forward. */
  | { ok: false; reason: "nonexistent"; message: string }
  /** Not a date, or not a time. */
  | { ok: false; reason: "invalid"; message: string };

export function resolveWallClock(
  date: string,
  time: string,
  timeZone: TimeZoneId,
): WallClockResolution {
  let plainDate: Temporal.PlainDate;
  let plainTime: Temporal.PlainTime;

  try {
    plainDate = Temporal.PlainDate.from(date);
    plainTime = Temporal.PlainTime.from(time);
  } catch {
    return {
      ok: false,
      reason: "invalid",
      message: "That is not a date and a time we can read.",
    };
  }

  const dateTime = plainDate.toPlainDateTime(plainTime);

  /* "reject" throws for BOTH awkward cases, so it cannot tell them apart on its
     own. It is used as the cheap test for "is this minute unremarkable", and
     the two branches below separate the two remaining possibilities. */
  try {
    const exact = dateTime.toZonedDateTime(timeZone, {
      disambiguation: "reject",
    });

    return { ok: true, instant: new Date(exact.epochMilliseconds), ambiguous: false };
  } catch {
    /* Either the time does not exist or it happens twice. Resolving it the
       lenient way and comparing the WALL CLOCK that comes back is what
       separates them: an ambiguous time round-trips to itself, a nonexistent
       one comes back as some other time entirely. */
    const lenient = dateTime.toZonedDateTime(timeZone, {
      disambiguation: "earlier",
    });

    if (
      lenient.hour !== plainTime.hour ||
      lenient.minute !== plainTime.minute ||
      lenient.day !== plainDate.day
    ) {
      return {
        ok: false,
        reason: "nonexistent",
        message: `${time} does not exist on ${date} — the clocks go forward that morning. Pick a time before or after the gap.`,
      };
    }

    return {
      ok: true,
      instant: new Date(lenient.epochMilliseconds),
      ambiguous: true,
    };
  }
}

/** The message that goes with `ambiguous: true`, so it is worded once. */
export const AMBIGUOUS_TIME_NOTE =
  "The clocks go back that morning, so that time happens twice. The earlier one was used.";
