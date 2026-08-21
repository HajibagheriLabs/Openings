import { z } from "zod";

import {
  LOCAL_TIME_PATTERN,
  findOverlappingIntervals,
  formatLocalMinutes,
  intervalLength,
  parseLocalTime,
  WEEKDAY_NAMES,
  type LocalInterval,
} from "@/lib/scheduling/week";

/**
 * The hours and time-off contracts, shared by the admin forms and the Server
 * Actions behind them.
 *
 * Same arrangement as the rest of the owner area: the client parses to put a
 * message beside the row, the server parses the identical schema again because
 * a Server Action is a public HTTP endpoint. No `server-only` here.
 */

const uuid = z.uuid("Unknown record.");

/** "2026-08-21" — a LOCAL calendar date, never an instant. */
const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-08-21.");

const localTime = z.string().regex(LOCAL_TIME_PATTERN, "Use HH:MM.");

/* ---------------------------------------------------------------------------
   Weekly hours
--------------------------------------------------------------------------- */

/** At most this many intervals on one day. A lunch break needs two. */
export const MAX_INTERVALS_PER_DAY = 4;

export const hoursIntervalSchema = z.object({
  startLocal: localTime,
  endLocal: localTime,
});

export const hoursDaySchema = z.object({
  weekday: z.number().int().min(0).max(6),
  /**
   * Empty means CLOSED. There is no separate "is open" flag, because an
   * absent interval already says it: `availability_rules` has no row for a day
   * the business is shut, and a boolean that had to agree with the array would
   * eventually stop agreeing.
   */
  intervals: z
    .array(hoursIntervalSchema)
    .max(
      MAX_INTERVALS_PER_DAY,
      `At most ${MAX_INTERVALS_PER_DAY} periods in one day.`,
    ),
});

/**
 * One version of a staff member's weekly hours.
 *
 * `effectiveFrom` is the LOCAL DATE the version starts applying. It is never
 * in the past — see the guard in the action, and the note in the editor. There
 * is no `effectiveTo` in the form: the end of a version is derived from where
 * the next one begins, so the two can never disagree.
 */
export const weeklyHoursSchema = z
  .object({
    staffId: uuid,
    effectiveFrom: localDate,
    days: z
      .array(hoursDaySchema)
      .length(7, "Every weekday needs a row.")
      .refine((days) => new Set(days.map((day) => day.weekday)).size === 7, {
        message: "Each weekday may appear once.",
      }),
  })
  .superRefine((value, ctx) => {
    /**
     * A WEEK NEEDS AT LEAST ONE OPEN PERIOD, and the reason is not tidiness.
     *
     * `availability_rules` expresses "closed" as the ABSENCE of a row, so a
     * week with nothing open writes no rows at all — and a version made of no
     * rows is indistinguishable from a version that was never created. The
     * save would appear to succeed, the previous open-ended version would
     * carry on unchanged, and the owner would be told their shop was closed
     * while it quietly kept taking bookings.
     *
     * Rather than inventing a sentinel row to mean "closed", this refuses and
     * names the two tools that genuinely express it: a closure is time off,
     * and someone who has stopped working is deactivated on the Staff page.
     */
    if (value.days.every((day) => day.intervals.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["days"],
        message:
          "A week needs at least one open period. To close for a stretch, block the dates on the Time off page — that keeps the weekly hours intact and shows the closure on the calendar. To stop offering someone entirely, switch them off on the Staff page.",
      });
    }

    /**
     * Each interval on its own: does it have a length at all?
     *
     * `end === start` is refused rather than read as a 24-hour shift. See
     * `intervalLength` — a silent 1440-minute interval would swallow the whole
     * day without ever looking wrong in the form.
     */
    for (const day of value.days) {
      const dayName = WEEKDAY_NAMES[day.weekday].label;

      day.intervals.forEach((interval, index) => {
        const start = parseLocalTime(interval.startLocal);
        const end = parseLocalTime(interval.endLocal);

        if (start === null || end === null) {
          return;
        }

        if (intervalLength(start, end) === null) {
          ctx.addIssue({
            code: "custom",
            path: ["days", day.weekday, "intervals", index],
            message: `${dayName}: the closing time has to differ from the opening time.`,
          });
        }
      });
    }

    /**
     * Then every interval against every other, ACROSS THE WHOLE WEEK.
     *
     * Not per weekday: midnight-crossing shifts are supported, so a Monday
     * 22:00–02:00 occupies part of Tuesday and collides with a Tuesday 01:00
     * rule. Checking days in isolation would let that pair through, and the
     * availability expansion would later produce two overlapping open
     * intervals for the same minutes.
     */
    const flat: (LocalInterval & { weekday: number })[] = [];

    for (const day of value.days) {
      for (const interval of day.intervals) {
        flat.push({
          weekday: day.weekday,
          startLocal: interval.startLocal,
          endLocal: interval.endLocal,
        });
      }
    }

    for (const pair of findOverlappingIntervals(flat)) {
      const first = flat[pair.first];
      const second = flat[pair.second];

      ctx.addIssue({
        code: "custom",
        path: ["days", first.weekday],
        message: overlapMessage(first, second),
      });
    }
  });

/**
 * Why two intervals collide, in the owner's own terms.
 *
 * Names both weekdays when they differ, because that is the case nobody
 * expects: the collision is the invisible consequence of a shift running past
 * midnight, and "Monday overlaps Tuesday" is the only version of the sentence
 * that explains itself.
 */
function overlapMessage(first: LocalInterval, second: LocalInterval): string {
  const firstDay = WEEKDAY_NAMES[first.weekday].label;
  const secondDay = WEEKDAY_NAMES[second.weekday].label;
  const firstText = `${first.startLocal}–${first.endLocal}`;
  const secondText = `${second.startLocal}–${second.endLocal}`;

  if (first.weekday === second.weekday) {
    return `${firstDay}: ${firstText} and ${secondText} overlap. Periods on one day have to be separate — a break is the gap between two of them.`;
  }

  const start = parseLocalTime(first.startLocal);
  const end = parseLocalTime(first.endLocal);
  const carriesOver = start !== null && end !== null && end < start;

  return carriesOver
    ? `${firstDay} ${firstText} runs past midnight into ${secondDay} and overlaps ${secondText} there. Shorten one of them.`
    : `${firstDay} ${firstText} and ${secondDay} ${secondText} overlap. Shorten one of them.`;
}

export type WeeklyHoursInput = z.input<typeof weeklyHoursSchema>;
export type WeeklyHoursOutput = z.output<typeof weeklyHoursSchema>;
export type HoursDayInput = z.input<typeof hoursDaySchema>;

/* ---------------------------------------------------------------------------
   Time off
--------------------------------------------------------------------------- */

export const timeOffSchema = z
  .object({
    /**
     * Null or absent means THE WHOLE BUSINESS is closed, matching the nullable
     * column. It is a distinct fact from "everyone happens to be off", and it
     * survives hiring someone new.
     */
    staffId: uuid.nullable().default(null),
    startDate: localDate,
    endDate: localDate,
    isAllDay: z.boolean(),
    startLocal: localTime.optional(),
    endLocal: localTime.optional(),
    reason: z
      .string()
      .trim()
      .max(200, "Keep the reason under 200 characters.")
      .default(""),
    /**
     * Set on the second submit, after the owner has seen the appointments this
     * closure lands on. The action refuses to write until it is true, so a
     * booking can never be blocked out without somebody having read the list.
     */
    acknowledgeConflicts: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.endDate < value.startDate) {
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "The last day cannot be before the first day.",
      });
    }

    if (value.isAllDay) {
      return;
    }

    if (!value.startLocal || !value.endLocal) {
      ctx.addIssue({
        code: "custom",
        path: ["startLocal"],
        message: "Give a start and an end time, or make it an all-day block.",
      });
      return;
    }

    // Only meaningful within a single day; across days the dates already order
    // the range, and 22:00 on Monday to 02:00 on Tuesday is perfectly normal.
    if (
      value.startDate === value.endDate &&
      value.endLocal <= value.startLocal
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["endLocal"],
        message: "The end has to come after the start.",
      });
    }
  });

export type TimeOffFormInput = z.input<typeof timeOffSchema>;
export type TimeOffFormOutput = z.output<typeof timeOffSchema>;

/** Human summary of a span of local minutes, used in a couple of places. */
export function describeIntervalMinutes(
  startMinute: number,
  durationMin: number,
): string {
  return `${formatLocalMinutes(startMinute)}–${formatLocalMinutes(
    startMinute + durationMin,
  )}`;
}
