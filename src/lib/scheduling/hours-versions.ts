import { Temporal } from "temporal-polyfill";

import { timeColumnToLocal } from "./week";

/**
 * Grouping `availability_rules` rows into dated versions.
 *
 * A VERSION IS EVERY RULE SHARING AN `effective_from`. The timeline is then
 * the sorted list of those dates, and each version runs until the day before
 * the next one starts.
 *
 * `effective_to` IS DERIVED HERE AND NOT READ FROM THE COLUMN. The column is
 * maintained by the save action, which reseals the whole chain after every
 * write, but deriving it on read as well means the two can never disagree: if
 * a row somehow carried a stale `effective_to` — a half-applied migration, a
 * hand-edited row — the screen would still show the truth the timeline
 * implies rather than the lie the column holds.
 *
 * Pure, and separated from the query that fetches the rows, so the boundary
 * arithmetic that decides "which version governs today" can be tested without
 * a database. That decision is the one with an off-by-one in it.
 *
 * Imports the polyfill directly rather than the `server-only` re-export,
 * because this file is pure logic with no I/O and the tests run in plain Node.
 */

export interface AvailabilityRuleRow {
  staffId: string;
  weekday: number;
  /** Postgres `time`, e.g. "09:00:00". */
  startLocal: string;
  endLocal: string;
  /** Local calendar date, e.g. "2026-09-01". */
  effectiveFrom: string;
}

export interface HoursDay {
  weekday: number;
  intervals: { startLocal: string; endLocal: string }[];
}

export interface HoursVersion {
  effectiveFrom: string;
  /** Derived: the day before the next version starts. Null when open-ended. */
  effectiveTo: string | null;
  days: HoursDay[];
  weeklyMinutes: number;
  /** Governing `today`. Exactly one version is current, when any rules exist. */
  isCurrent: boolean;
  /** Not started yet — the only kind that may be discarded. */
  isFuture: boolean;
  /** Superseded. Read-only: it already governed days that were booked. */
  isPast: boolean;
}

/** Seven empty days — the shape a fully closed week has. */
export function emptyWeek(): HoursDay[] {
  return Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    intervals: [],
  }));
}

/**
 * Total minutes a week.
 *
 * Wall-clock minute arithmetic with the midnight carry the schema documents.
 * No dates are involved, so no timezone can be wrong here — and a night shift
 * counts its real length rather than a negative number.
 */
export function weeklyMinutesOf(days: HoursDay[]): number {
  let total = 0;

  for (const day of days) {
    for (const interval of day.intervals) {
      const start = minutesOf(interval.startLocal);
      const end = minutesOf(interval.endLocal);

      total += end > start ? end - start : 1440 - start + end;
    }
  }

  return total;
}

function minutesOf(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);

  return hours * 60 + minutes;
}

/**
 * Rows for ONE staff member into their timeline, oldest first.
 *
 * `today` is the business's LOCAL date. Comparing ISO date strings
 * lexicographically is exact for this format, which is why the boundaries are
 * plain string comparisons rather than parsed dates.
 */
export function groupIntoVersions(
  rules: AvailabilityRuleRow[],
  today: string,
): HoursVersion[] {
  const byVersion = new Map<string, HoursDay[]>();

  for (const rule of rules) {
    const days = byVersion.get(rule.effectiveFrom) ?? emptyWeek();

    days[rule.weekday].intervals.push({
      startLocal: timeColumnToLocal(rule.startLocal),
      endLocal: timeColumnToLocal(rule.endLocal),
    });

    byVersion.set(rule.effectiveFrom, days);
  }

  const starts = [...byVersion.keys()].sort();

  return starts.map((effectiveFrom, index) => {
    const next = starts[index + 1] ?? null;
    const days = byVersion.get(effectiveFrom) ?? emptyWeek();

    // Intervals arrive in whatever order the query returned; a day reads as a
    // day, so sort them by their start.
    for (const day of days) {
      day.intervals.sort((a, b) => a.startLocal.localeCompare(b.startLocal));
    }

    return {
      effectiveFrom,
      effectiveTo: next ? previousDay(next) : null,
      days,
      weeklyMinutes: weeklyMinutesOf(days),
      /**
       * In force when it has started AND the next one has not.
       *
       * `today < next` rather than `today <= next`: a version starting today
       * takes over today, so the one before it ended yesterday. Getting this
       * backwards would show two versions as current on every changeover day.
       */
      isCurrent: effectiveFrom <= today && (next === null || today < next),
      isFuture: effectiveFrom > today,
      isPast: next !== null && next <= today,
    };
  });
}

/** "2026-09-01" to "2026-08-31" — calendar arithmetic, never minus 86400000. */
export function previousDay(date: string): string {
  return Temporal.PlainDate.from(date).subtract({ days: 1 }).toString();
}
