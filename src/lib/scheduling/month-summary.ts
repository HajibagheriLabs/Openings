import "server-only";

import type { Db } from "@/db/client";

import { getAvailability } from "./availability";
import { Temporal, type TimeZoneId } from "./temporal";

/**
 * A month of the booking calendar, as one question.
 *
 * WHY THIS EXISTS AT ALL. The month picker needs one bit per day: is there
 * anything free? The obvious way to get thirty of those is thirty availability
 * calls, which is thirty times the database round trips for a screen that
 * draws thirty small squares — and it is exactly why booking pages feel slow.
 * `getAvailability` already takes a DATE RANGE and costs five queries whether
 * that range is one day or sixty, so a month summary is one call to it plus a
 * bucketing loop in memory. The month costs what the day cost.
 *
 * Everything here is resolved in the BUSINESS's timezone. "Which day is this
 * slot on" is a question about the shop's calendar, not the server's and not
 * the visitor's, and the answer changes on the two days a year a local day is
 * not twenty-four hours long.
 */

export interface DayOpenings {
  /** Local calendar date in the business timezone, "2026-09-03". */
  date: string;
  /** How many start times are offered. Zero means the day is not selectable. */
  openings: number;
  /** ISO instant of the earliest opening, or null when there is none. */
  firstStartsAt: string | null;
}

export interface MonthSummary {
  timeZone: TimeZoneId;
  /**
   * The month this summary is actually about, "2026-09".
   *
   * Not necessarily the one that was asked for — see the clamp in
   * `loadMonthSummary`. Callers should render THIS rather than their own
   * request, or the calendar and its days come from different months.
   */
  month: string;
  /** Every local day of the month, in order, including the empty ones. */
  days: DayOpenings[];
  /** Openings across the whole month. Zero drives the empty state. */
  openings: number;
  /**
   * What the booking policy allows anywhere, as local dates. The calendar
   * clamps its navigation to these, so a visitor cannot page into 2043 and
   * wonder why every day is grey.
   */
  horizon: { from: string; to: string; firstMonth: string; lastMonth: string };
  /**
   * The next local date with an opening AFTER this month, within the horizon.
   *
   * Only looked up when the month came back empty — an empty calendar with no
   * way forward is a dead end, and "the next opening is Thursday 2 October" is
   * the one sentence that rescues it. Costs a second call, and only then.
   */
  nextOpen: { date: string; month: string; startsAt: string } | null;
}

export interface MonthSummaryRequest {
  db: Db;
  businessId: string;
  serviceId: string;
  staffId: string | "any";
  timeZone: TimeZoneId;
  /** How far ahead the business is open for bookings, in calendar days. */
  maxAdvanceDays: number;
  /** "2026-09". */
  month: string;
  /** Injected clock. Tests pass their own; the page passes the real one. */
  now?: Date;
}

/** "2026-09-03" to "2026-09". */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** Today, as a local calendar date in the business's zone. */
export function todayIn(timeZone: TimeZoneId, now: Date): string {
  return Temporal.Instant.fromEpochMilliseconds(now.getTime())
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString();
}

/**
 * A local calendar date as a real instant, for labelling it.
 *
 * "2026-09-03" is not a moment, and `formatInstantDate` needs one. Midday
 * rather than midnight: a handful of zones move their clocks AT midnight, so
 * the start of a local day is occasionally a wall-clock time that does not
 * exist. Noon is never ambiguous anywhere, and the only thing read back off
 * this instant is which day it is.
 */
export function localDateInstant(date: string, timeZone: TimeZoneId): string {
  return Temporal.PlainDate.from(date)
    .toZonedDateTime({ timeZone, plainTime: Temporal.PlainTime.from("12:00") })
    .toInstant()
    .toString();
}

/** The current month in the business's zone, "2026-09". */
export function currentMonthIn(timeZone: TimeZoneId, now: Date): string {
  return monthOf(todayIn(timeZone, now));
}

function laterOf(a: Temporal.PlainDate, b: Temporal.PlainDate) {
  return Temporal.PlainDate.compare(a, b) >= 0 ? a : b;
}

function earlierOf(a: Temporal.PlainDate, b: Temporal.PlainDate) {
  return Temporal.PlainDate.compare(a, b) <= 0 ? a : b;
}

/**
 * Group slots by the local day they start on.
 *
 * `toZonedDateTimeISO(timeZone).toPlainDate()` is the whole point: a 00:30
 * instant belongs to the day the SHOP calls 00:30, which is not necessarily
 * the day the server or the visitor would call it.
 */
function bucketByLocalDate(
  slots: { startsAt: string }[],
  timeZone: TimeZoneId,
): Map<string, { openings: number; firstStartsAt: string }> {
  const byDate = new Map<string, { openings: number; firstStartsAt: string }>();

  for (const slot of slots) {
    const date = Temporal.Instant.from(slot.startsAt)
      .toZonedDateTimeISO(timeZone)
      .toPlainDate()
      .toString();

    const existing = byDate.get(date);

    if (existing) {
      existing.openings += 1;
    } else {
      // The slot list is ascending, so the first one seen for a day is the
      // earliest one on it.
      byDate.set(date, { openings: 1, firstStartsAt: slot.startsAt });
    }
  }

  return byDate;
}

/**
 * Load one month.
 *
 * Returns null only when the service does not exist or is not this business's —
 * the same answer either way, because from outside, a service you cannot see is
 * indistinguishable from one that was never created.
 */
export async function loadMonthSummary(
  request: MonthSummaryRequest,
): Promise<MonthSummary | null> {
  const { db, businessId, serviceId, staffId, timeZone } = request;
  const clock = request.now ?? new Date();

  const today = Temporal.PlainDate.from(todayIn(timeZone, clock));
  /**
   * The horizon is a COUNT OF CALENDAR DAYS from today, inclusive — the same
   * reading `computeAvailability` applies to `max_advance_days`. Anything else
   * and the last day the calendar offers and the last day the engine allows
   * disagree by one, which the visitor discovers by tapping a day that turns
   * out to be empty.
   */
  const horizonEnd = today.add({ days: request.maxAdvanceDays });

  const firstMonth = today.toPlainYearMonth();
  const lastMonth = horizonEnd.toPlainYearMonth();

  /**
   * THE MONTH IS CLAMPED TO THE HORIZON.
   *
   * A `?month=` from a link sent in June, or typed by somebody curious, can
   * name any month at all. Rendering it faithfully would put a calendar on
   * screen showing a month whose navigation buttons are both dead — every day
   * grey, no way forward and no way back. Clamping answers the question the
   * visitor actually has ("when can I come in?") with the nearest month that
   * can contain an answer.
   */
  const requested = Temporal.PlainYearMonth.from(request.month);
  const yearMonth =
    Temporal.PlainYearMonth.compare(requested, firstMonth) < 0
      ? firstMonth
      : Temporal.PlainYearMonth.compare(requested, lastMonth) > 0
        ? lastMonth
        : requested;

  const monthStart = yearMonth.toPlainDate({ day: 1 });
  const monthEnd = monthStart.add({ months: 1 }).subtract({ days: 1 });

  const horizon = {
    from: today.toString(),
    to: horizonEnd.toString(),
    firstMonth: firstMonth.toString(),
    lastMonth: lastMonth.toString(),
  };

  /* The days actually worth asking about: this month, clipped to the horizon.
     A month entirely behind today, or entirely beyond the horizon, asks
     nothing — every one of its days is empty by policy, and a query would only
     confirm that at the cost of a round trip. */
  const from = laterOf(monthStart, today);
  const to = earlierOf(monthEnd, horizonEnd);
  const hasQueryableDays = Temporal.PlainDate.compare(from, to) <= 0;

  let byDate = new Map<string, { openings: number; firstStartsAt: string }>();

  if (hasQueryableDays) {
    const result = await getAvailability({
      db,
      businessId,
      serviceId,
      staffId,
      from: from.toString(),
      to: to.toString(),
      now: clock,
    });

    if (!result) {
      return null;
    }

    byDate = bucketByLocalDate(result.slots, timeZone);
  }

  const days: DayOpenings[] = [];

  for (let day = 1; day <= monthStart.daysInMonth; day += 1) {
    const date = monthStart.with({ day }).toString();
    const found = byDate.get(date);

    days.push({
      date,
      openings: found?.openings ?? 0,
      firstStartsAt: found?.firstStartsAt ?? null,
    });
  }

  const openings = days.reduce((total, day) => total + day.openings, 0);

  return {
    timeZone,
    month: yearMonth.toString(),
    days,
    openings,
    horizon,
    nextOpen:
      openings > 0
        ? null
        : await findNextOpen({
            ...request,
            now: clock,
            after: monthEnd,
            today,
            horizonEnd,
          }),
  };
}

/**
 * The first opening after a month that had none, within the horizon.
 *
 * One extra availability call over the REST of the horizon — sixty-odd days by
 * default, still five queries — and it happens only on an empty month. A
 * visitor staring at a blank October is exactly the person who needs to be
 * told that November has something.
 */
async function findNextOpen(
  request: MonthSummaryRequest & {
    after: Temporal.PlainDate;
    today: Temporal.PlainDate;
    horizonEnd: Temporal.PlainDate;
  },
): Promise<MonthSummary["nextOpen"]> {
  /* Start the day after the month that came back empty — or today, if that
     month is already behind us, so a stale shared link still finds the
     answer. */
  const from = laterOf(request.after.add({ days: 1 }), request.today);

  if (Temporal.PlainDate.compare(from, request.horizonEnd) > 0) {
    return null;
  }

  const result = await getAvailability({
    db: request.db,
    businessId: request.businessId,
    serviceId: request.serviceId,
    staffId: request.staffId,
    from: from.toString(),
    to: request.horizonEnd.toString(),
    now: request.now,
  });

  const first = result?.slots[0];

  if (!first) {
    return null;
  }

  const date = Temporal.Instant.from(first.startsAt)
    .toZonedDateTimeISO(request.timeZone)
    .toPlainDate()
    .toString();

  return { date, month: monthOf(date), startsAt: first.startsAt };
}
