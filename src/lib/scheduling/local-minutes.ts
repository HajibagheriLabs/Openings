import { Temporal, type TimeZoneId } from "./temporal";

/**
 * Where an instant falls on a local day's ruler.
 *
 * ONE IMPLEMENTATION, SHARED BY THE PICKER AND THE AGENDA. The customer's day
 * picker and the owner's calendar draw the same Ribbon at the same scale, so
 * they have to agree, to the minute, about where nine o'clock is. Two copies of
 * this arithmetic would eventually disagree on exactly the day it matters.
 *
 * WALL CLOCK, NOT ELAPSED TIME. A shift running past midnight comes back as
 * 1500 rather than wrapping to 60, and the Ribbon's ruler is labelled from
 * exactly this number. On the one day a year a local day is 23 or 25 hours long
 * the ruler and true elapsed time drift by an hour after the transition —
 * accepted deliberately, because the transition happens at 02:00 or 03:00,
 * outside every published opening hour this product has seen, and because a
 * ruler that says 09:00 where the shop opens at 09:00 is worth more than one
 * that is arithmetically pure and reads an hour early. The times ON the
 * segments are formatted from real instants and are never affected.
 */
export function localMinuteOf(
  instant: string | Date,
  date: string,
  timeZone: TimeZoneId,
): number {
  const zoned = (
    instant instanceof Date
      ? Temporal.Instant.fromEpochMilliseconds(instant.getTime())
      : Temporal.Instant.from(instant)
  ).toZonedDateTimeISO(timeZone);

  const day = Temporal.PlainDate.from(date);
  const dayOffset = zoned.toPlainDate().since(day, { largestUnit: "day" }).days;

  return dayOffset * 1440 + zoned.hour * 60 + zoned.minute;
}

/** Round a minute down to the hour, for a window that starts on the clock. */
export function floorHour(minute: number): number {
  return Math.floor(minute / 60) * 60;
}

/** Round a minute up to the hour, for a window that ends on the clock. */
export function ceilHour(minute: number): number {
  return Math.ceil(minute / 60) * 60;
}

/**
 * The calendar date an instant falls on, in a given zone, as "2026-08-29".
 *
 * FORMATTING, NOT ARITHMETIC. `en-CA` renders ISO-ordered parts, so a date
 * comes out of `Intl` without anybody adding an offset to anything.
 */
export function localDateOf(instant: Date, timeZone: TimeZoneId): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}
