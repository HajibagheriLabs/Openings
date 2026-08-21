/**
 * Weekly wall-clock arithmetic.
 *
 * THIS MODULE CONTAINS NO TIMEZONE MATH AND NO INSTANTS, ON PURPOSE.
 *
 * A recurring weekly rule — "Monday, 09:00 to 17:00" — is a fact about the
 * clock on the wall, not about a moment in time. It has no offset, no date,
 * and no UTC equivalent; the same rule means a different instant every week of
 * the year and two different instants on the two days DST moves. So the rules
 * are compared, overlapped and drawn purely as MINUTES, and only the
 * expansion into a concrete day (src/lib/scheduling, server-side, with
 * Temporal) ever turns one into an instant.
 *
 * Because it is instant-free it is also safe on the client, which is what lets
 * the hours editor preview a week as it is typed without a round trip and
 * without the client ever doing date arithmetic. Formatting minute 540 as
 * "09:00" is not date arithmetic — 540 minutes past midnight IS nine o'clock,
 * in every timezone, forever.
 *
 * MIDNIGHT-CROSSING SHIFTS ARE SUPPORTED. `end_local < start_local` means the
 * interval carries into the next day, exactly as the schema documents. That
 * choice is why overlap is checked in WEEK minutes rather than per weekday: a
 * Monday 22:00–02:00 shift occupies part of Tuesday, and a Tuesday 01:00 rule
 * genuinely collides with it. Checking each weekday in isolation would miss
 * that, and the collision would surface much later as two overlapping open
 * intervals in the availability expansion.
 */

export const MINUTES_PER_DAY = 1440;
export const DAYS_PER_WEEK = 7;
export const MINUTES_PER_WEEK = MINUTES_PER_DAY * DAYS_PER_WEEK;

/** "HH:MM", 24-hour, as `<input type="time">` produces and `time` stores. */
export const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 0 = Sunday … 6 = Saturday, matching Postgres `extract(dow)`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface LocalInterval {
  weekday: number;
  /** "09:00" — local wall-clock in the business timezone. Never an instant. */
  startLocal: string;
  /** "17:00". Less than `startLocal` means the shift carries past midnight. */
  endLocal: string;
}

/* ---------------------------------------------------------------------------
   Minutes to text and back
--------------------------------------------------------------------------- */

/** "09:30" to 570. Returns null when the string is not a wall-clock time. */
export function parseLocalTime(value: string): number | null {
  if (!LOCAL_TIME_PATTERN.test(value)) {
    return null;
  }

  const [hours, minutes] = value.split(":").map(Number);

  return hours * 60 + minutes;
}

/**
 * 570 to "09:30".
 *
 * Minutes at or beyond a full day wrap, so the end of a midnight-crossing
 * shift reads "02:00" rather than "26:00". The day it lands on is carried by
 * the caller, not by the clock face.
 */
export function formatLocalMinutes(minute: number): string {
  const wrapped = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) %
    MINUTES_PER_DAY;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** "09:00 – 17:00", the label a wall-clock span carries. */
export function formatLocalMinuteRange(
  startMinute: number,
  durationMin: number,
): string {
  return `${formatLocalMinutes(startMinute)} – ${formatLocalMinutes(
    startMinute + durationMin,
  )}`;
}

/** Postgres `time` ("09:00:00") to the "HH:MM" the form uses. */
export function timeColumnToLocal(value: string): string {
  return value.slice(0, 5);
}

/** "09:00" to the Postgres `time` literal. */
export function localToTimeColumn(value: string): string {
  return `${value}:00`;
}

/* ---------------------------------------------------------------------------
   Spans in week-minute space
--------------------------------------------------------------------------- */

export interface WeekSpan {
  /** Minutes from Sunday 00:00. Always inside [0, MINUTES_PER_WEEK). */
  start: number;
  /** Length in minutes. Always positive; may carry the span past the week end. */
  length: number;
}

/**
 * How long an interval lasts, given that the end may be on the next day.
 *
 * `end === start` is REFUSED rather than read as a 24-hour shift. Somebody
 * typing 09:00 to 09:00 has made a mistake far more often than they have
 * meant "open around the clock", and a silent 1440-minute interval would
 * swallow the entire day's availability without ever looking wrong in the
 * form.
 */
export function intervalLength(
  startMinute: number,
  endMinute: number,
): number | null {
  if (endMinute === startMinute) {
    return null;
  }

  return endMinute > startMinute
    ? endMinute - startMinute
    : MINUTES_PER_DAY - startMinute + endMinute;
}

/** One interval placed on the week's clock. Null when it has no valid length. */
export function toWeekSpan(interval: LocalInterval): WeekSpan | null {
  const start = parseLocalTime(interval.startLocal);
  const end = parseLocalTime(interval.endLocal);

  if (start === null || end === null) {
    return null;
  }

  const length = intervalLength(start, end);

  if (length === null) {
    return null;
  }

  return { start: interval.weekday * MINUTES_PER_DAY + start, length };
}

/** True when the interval carries past midnight into the following day. */
export function crossesMidnight(interval: LocalInterval): boolean {
  const start = parseLocalTime(interval.startLocal);
  const end = parseLocalTime(interval.endLocal);

  return start !== null && end !== null && end < start;
}

/**
 * A span unrolled into pieces that do not wrap past the end of the week.
 *
 * A Saturday 23:00–01:00 shift ends on Sunday, which in week-minute terms is
 * minute 0 of the SAME week, not minute 10080 of a following one. Splitting it
 * here is what makes a plain numeric overlap test correct for it.
 */
function unroll(span: WeekSpan): { start: number; end: number }[] {
  const end = span.start + span.length;

  if (end <= MINUTES_PER_WEEK) {
    return [{ start: span.start, end }];
  }

  return [
    { start: span.start, end: MINUTES_PER_WEEK },
    { start: 0, end: end - MINUTES_PER_WEEK },
  ];
}

/**
 * Do two intervals share any minute of the week?
 *
 * Half-open on both sides, matching every other range in this project: an
 * interval ending at 12:00 and one starting at 12:00 do NOT overlap, which is
 * what makes a lunch break expressible as two adjacent intervals rather than
 * needing a "break" concept of its own.
 */
export function weekSpansOverlap(a: WeekSpan, b: WeekSpan): boolean {
  for (const pieceA of unroll(a)) {
    for (const pieceB of unroll(b)) {
      if (pieceA.start < pieceB.end && pieceB.start < pieceA.end) {
        return true;
      }
    }
  }

  return false;
}

export interface OverlapPair {
  /** Indexes into the array that was checked. */
  first: number;
  second: number;
}

/**
 * Every pair of intervals that collide, across the whole week.
 *
 * Returns pairs rather than a boolean so the form can mark BOTH offending
 * rows. "Something overlaps" sends the owner hunting; two highlighted rows and
 * a sentence naming them does not.
 */
export function findOverlappingIntervals(
  intervals: LocalInterval[],
): OverlapPair[] {
  const spans = intervals.map(toWeekSpan);
  const pairs: OverlapPair[] = [];

  for (let i = 0; i < spans.length; i += 1) {
    const a = spans[i];

    if (!a) {
      continue;
    }

    for (let j = i + 1; j < spans.length; j += 1) {
      const b = spans[j];

      if (b && weekSpansOverlap(a, b)) {
        pairs.push({ first: i, second: j });
      }
    }
  }

  return pairs;
}

/* ---------------------------------------------------------------------------
   Drawing a week
--------------------------------------------------------------------------- */

export interface DaySpan {
  /** Which weekday column this piece belongs in. */
  weekday: number;
  /** Minutes since local midnight ON THAT DAY. */
  startMinute: number;
  durationMin: number;
  /** True for the tail of a shift that started the day before. */
  isContinuation: boolean;
  /** The whole interval's label, e.g. "22:00 – 02:00". */
  label: string;
}

/**
 * Intervals cut into per-day pieces, ready for the Ribbon's seven columns.
 *
 * A midnight-crossing shift becomes TWO pieces in two columns, because that is
 * what it looks like on a calendar. The second piece is marked as a
 * continuation so the preview can say so rather than implying the owner
 * configured a mysterious 02:00 opening on Tuesday.
 */
export function splitIntoDaySpans(intervals: LocalInterval[]): DaySpan[] {
  const spans: DaySpan[] = [];

  for (const interval of intervals) {
    const start = parseLocalTime(interval.startLocal);
    const end = parseLocalTime(interval.endLocal);

    if (start === null || end === null) {
      continue;
    }

    const length = intervalLength(start, end);

    if (length === null) {
      continue;
    }

    const label = formatLocalMinuteRange(start, length);
    const firstPiece = Math.min(length, MINUTES_PER_DAY - start);

    spans.push({
      weekday: interval.weekday,
      startMinute: start,
      durationMin: firstPiece,
      isContinuation: false,
      label,
    });

    const remainder = length - firstPiece;

    if (remainder > 0) {
      spans.push({
        weekday: (interval.weekday + 1) % DAYS_PER_WEEK,
        startMinute: 0,
        durationMin: remainder,
        isContinuation: true,
        label,
      });
    }
  }

  return spans;
}

/**
 * The slice of the day worth drawing, given what is configured.
 *
 * Padded by an hour on each side and snapped to the hour, so a 09:00 opening
 * does not sit flush against the top edge of the ribbon. Falls back to a
 * plain working day when nothing is configured at all — an empty week should
 * still look like a week.
 */
export function weekWindow(
  spans: DaySpan[],
  fallback: { startMinute: number; endMinute: number } = {
    startMinute: 8 * 60,
    endMinute: 20 * 60,
  },
): { startMinute: number; endMinute: number } {
  if (spans.length === 0) {
    return fallback;
  }

  let earliest = MINUTES_PER_DAY;
  let latest = 0;

  for (const span of spans) {
    earliest = Math.min(earliest, span.startMinute);
    latest = Math.max(latest, span.startMinute + span.durationMin);
  }

  return {
    startMinute: Math.max(0, Math.floor((earliest - 60) / 60) * 60),
    endMinute: Math.min(MINUTES_PER_DAY, Math.ceil((latest + 60) / 60) * 60),
  };
}

/** Sunday-first, matching `extract(dow)` and the `weekday` column. */
export const WEEKDAY_NAMES = [
  { weekday: 0, label: "Sunday", short: "Sun" },
  { weekday: 1, label: "Monday", short: "Mon" },
  { weekday: 2, label: "Tuesday", short: "Tue" },
  { weekday: 3, label: "Wednesday", short: "Wed" },
  { weekday: 4, label: "Thursday", short: "Thu" },
  { weekday: 5, label: "Friday", short: "Fri" },
  { weekday: 6, label: "Saturday", short: "Sat" },
] as const;

/**
 * Monday first, which is how the grid is READ.
 *
 * The storage order stays Sunday-first because Postgres `extract(dow)` is
 * Sunday-first and the column has to match it. Reordering for display here,
 * once, is cheaper than a schema that disagrees with its own database.
 */
export const WEEKDAYS_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** Monday to Friday — what "copy to all weekdays" means. */
export const BUSINESS_WEEKDAYS = [1, 2, 3, 4, 5] as const;
