import "server-only";

import { toTstzRangeLiteral } from "./slot";
import { Temporal, type TimeZoneId } from "./temporal";

/**
 * Turning a closure a person described into a range the database can subtract.
 *
 * THE ALL-DAY BUG THIS MODULE EXISTS TO PREVENT
 * --------------------------------------------
 * "Closed on 25 December" is a LOCAL DAY. The obvious implementation —
 * `new Date("2026-12-25T00:00:00Z")` to `+24h` — is wrong for every business
 * that is not on UTC, and wrongness is silent: a shop in Berlin would be
 * closed from 01:00 on the 25th to 01:00 on the 26th, so an 09:00 appointment
 * on Boxing Day would be blocked and the last hour of Christmas Eve would
 * stay bookable. Nobody notices until a customer books a day the shop is shut.
 *
 * It is worse twice a year. A local day is not always 24 hours: on a
 * spring-forward day it is 23, on a fall-back day it is 25. Adding a fixed
 * `PT24H` therefore lands an hour early or an hour late, and the closure
 * either leaks into the next day or leaves an hour of the closed day open.
 *
 * So an all-day range is built from the LOCAL DAY BOUNDARIES: the start of the
 * first day to the start of the day AFTER the last day, both resolved in the
 * business's own timezone. `startOfDay()` asks the timezone where that
 * boundary actually is, which is the only way to be right on all 365 days.
 * These cases have tests.
 */

/** What the owner filled in. Dates and times are LOCAL to the business. */
export interface TimeOffInput {
  /** "2026-12-25" — a local calendar date, not an instant. */
  startDate: string;
  endDate: string;
  /** "09:00". Ignored, and may be absent, when `isAllDay`. */
  startLocal?: string;
  endLocal?: string;
  isAllDay: boolean;
}

export interface ResolvedTimeOff {
  /** The Postgres `tstzrange` literal, half-open. */
  range: string;
  startsAt: Date;
  endsAt: Date;
}

export type TimeOffResolutionError =
  | "invalid-date"
  | "invalid-time"
  | "end-before-start"
  | "empty-range";

export type TimeOffResolution =
  | { ok: true; value: ResolvedTimeOff }
  | { ok: false; error: TimeOffResolutionError; message: string };

/**
 * Local dates and times to a real instant range, in the business's timezone.
 *
 * `disambiguation: "compatible"` is the deliberate choice for the two awkward
 * days. A closure is a blunt instrument — it removes time — so when a local
 * time does not exist (spring forward) or happens twice (fall back), erring
 * toward covering MORE of the day is the safe direction: the worst outcome is
 * an hour that could have been sold, rather than an appointment accepted on a
 * day the business is shut. Booking, where the opposite is true, resolves
 * ambiguity explicitly instead of accepting a default.
 */
export function resolveTimeOffRange(
  input: TimeOffInput,
  timeZone: TimeZoneId,
): TimeOffResolution {
  let startDate: Temporal.PlainDate;
  let endDate: Temporal.PlainDate;

  try {
    startDate = Temporal.PlainDate.from(input.startDate);
    endDate = Temporal.PlainDate.from(input.endDate);
  } catch {
    return {
      ok: false,
      error: "invalid-date",
      message: "Pick a start and an end date.",
    };
  }

  if (Temporal.PlainDate.compare(endDate, startDate) < 0) {
    return {
      ok: false,
      error: "end-before-start",
      message: "The last day cannot be before the first day.",
    };
  }

  if (input.isAllDay) {
    /**
     * THE LOCAL DAY BOUNDARIES.
     *
     * Start of the first day, to the start of the day AFTER the last day.
     * `startOfDay()` resolves each boundary in the business's zone, so it
     * lands on the real local midnight even when that midnight is not 00:00
     * UTC and even when the day it opens is 23 or 25 hours long.
     *
     * The upper bound is exclusive, so "25th to 25th" covers exactly the 25th
     * and an appointment starting at 00:00 on the 26th is untouched.
     */
    const startsAt = startDate.toZonedDateTime(timeZone).startOfDay();
    const endsAt = endDate
      .add({ days: 1 })
      .toZonedDateTime(timeZone)
      .startOfDay();

    return {
      ok: true,
      value: buildRange(startsAt, endsAt),
    };
  }

  const startTime = parsePlainTime(input.startLocal);
  const endTime = parsePlainTime(input.endLocal);

  if (!startTime || !endTime) {
    return {
      ok: false,
      error: "invalid-time",
      message: "Write the times as HH:MM, for example 13:00.",
    };
  }

  const startsAt = startDate.toZonedDateTime({
    timeZone,
    plainTime: startTime,
  });
  const endsAt = endDate.toZonedDateTime({ timeZone, plainTime: endTime });

  if (Temporal.ZonedDateTime.compare(endsAt, startsAt) <= 0) {
    return {
      ok: false,
      error: "empty-range",
      message: "The end has to come after the start.",
    };
  }

  return { ok: true, value: buildRange(startsAt, endsAt) };
}

function buildRange(
  startsAt: Temporal.ZonedDateTime,
  endsAt: Temporal.ZonedDateTime,
): ResolvedTimeOff {
  const start = new Date(startsAt.epochMilliseconds);
  const end = new Date(endsAt.epochMilliseconds);

  return { range: toTstzRangeLiteral(start, end), startsAt: start, endsAt: end };
}

function parsePlainTime(value: string | undefined): Temporal.PlainTime | null {
  if (!value) {
    return null;
  }

  try {
    return Temporal.PlainTime.from(value);
  } catch {
    return null;
  }
}

/**
 * How many local days a closure covers, for the summary line.
 *
 * Counted in CALENDAR DAYS rather than by dividing the range by 24 hours,
 * which is the same class of mistake as the one above: across a DST boundary
 * the division gives 2.96 days for a three-day closure.
 */
export function countLocalDays(
  startsAt: Date,
  endsAt: Date,
  timeZone: TimeZoneId,
): number {
  const start = Temporal.Instant.fromEpochMilliseconds(startsAt.getTime())
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();

  /**
   * One millisecond back off the exclusive upper bound, so a closure ending
   * at local midnight belongs to the day before it rather than nominating the
   * next day as a fourth day of a three-day holiday.
   */
  const lastMoment = Temporal.Instant.fromEpochMilliseconds(
    endsAt.getTime() - 1,
  )
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();

  return start.until(lastMoment, { largestUnit: "day" }).days + 1;
}

/** True when the range covers whole local days end to end. */
export function coversWholeLocalDays(
  startsAt: Date,
  endsAt: Date,
  timeZone: TimeZoneId,
): boolean {
  const start = Temporal.Instant.fromEpochMilliseconds(startsAt.getTime())
    .toZonedDateTimeISO(timeZone);
  const end = Temporal.Instant.fromEpochMilliseconds(endsAt.getTime())
    .toZonedDateTimeISO(timeZone);

  return (
    start.equals(start.startOfDay()) &&
    end.equals(end.startOfDay()) &&
    Temporal.ZonedDateTime.compare(end, start) > 0
  );
}

/* ===========================================================================
   SEAM: recurring closures
   ---------------------------------------------------------------------------
   OUT OF SCOPE FOR NOW, AND HERE IS WHERE IT WOULD GO.

   Every closure this module produces is a single concrete instant range, which
   is why `time_off.range` is a tstzrange and why the availability expansion can
   subtract it with one `&&` test against a GiST index. A recurring closure —
   "closed every public holiday", "closed the first Monday of the month" — is a
   RULE, not a range, and it must not be stored in that column.

   The shape it would take, when it is built:

     1. A new table, `time_off_rules`, holding the recurrence in local terms
        the way `availability_rules` does: an RFC 5545 RRULE string plus a
        local start time and duration, never instants. The same reasoning
        applies as for weekly hours — "closed every 1 January" has to survive
        a DST change and a leap year, and an instant does not.

     2. An expansion step in the availability algorithm, immediately after the
        weekly rules are expanded and BEFORE concrete time_off rows are
        subtracted. It would produce the same `{ startsAt, endsAt }` pairs this
        module produces, in the business timezone, so everything downstream —
        the subtraction, the conflict warning, the ribbon preview — keeps
        working unchanged.

     3. Materialisation is NOT the answer. Writing a year of concrete rows for
        each rule would make editing the rule a migration, and would silently
        disagree with itself the moment the business timezone changed.

   Nothing is stubbed for it here: there is no dead code and no unused column,
   because a half-built recurrence is worse than none. This comment is the
   seam.
   =========================================================================== */
