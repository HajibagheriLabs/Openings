import { Temporal } from "./temporal";

/**
 * Building the blocking range.
 *
 * An appointment has two different spans and confusing them is the bug this
 * module exists to prevent:
 *
 *   starts_at / ends_at   what the customer is told, and what the confirmation
 *                         email and the .ics file say. Exactly the service
 *                         duration.
 *
 *   slot                  what the calendar is not allowed to double-book.
 *                         The customer-facing span WIDENED by the service's
 *                         before/after buffers.
 *
 * Buffers live in the stored range so that the exclusion constraint enforces
 * them for free. No availability query, and no future query anybody writes,
 * has to remember to add them — forgetting a buffer stops being possible.
 */

/** The buffer/duration fields this module needs off a service row. */
export interface ServiceTiming {
  /** Customer-facing length, in minutes. */
  durationMin: number;
  /** Dead time reserved before the appointment. */
  bufferBeforeMin: number;
  /** Dead time reserved after the appointment. */
  bufferAfterMin: number;
}

export interface BlockingRange {
  /** Customer-facing start. */
  startsAt: Date;
  /** Customer-facing end: startsAt + durationMin. */
  endsAt: Date;
  /** The Postgres `tstzrange` literal, buffers included. Half-open. */
  slot: string;
  /** Lower bound of `slot` — startsAt minus the before-buffer. */
  blockingStart: Date;
  /** Upper bound of `slot` — endsAt plus the after-buffer. */
  blockingEnd: Date;
}

/**
 * Format a half-open Postgres range literal: `["lower","upper")`.
 *
 * THE BOUNDS ARE THE WHOLE POINT.
 *
 * `[` makes the lower bound INCLUSIVE and `)` makes the upper bound EXCLUSIVE.
 * With those bounds, `[10:00, 11:00)` and `[11:00, 12:00)` do NOT overlap —
 * Postgres `&&` is false for them — so two back-to-back appointments are both
 * insertable and the day can actually be filled.
 *
 * If the upper bound were inclusive (`]`), the two ranges would share the
 * instant 11:00, `&&` would be true, and the exclusion constraint would reject
 * the second booking. Every consecutive appointment in the product would fail.
 * That is why this is never left to a default.
 */
export function toTstzRangeLiteral(lower: Date, upper: Date): string {
  return `["${lower.toISOString()}","${upper.toISOString()}")`;
}

/**
 * Build the customer-facing times and the blocking range for one appointment.
 *
 * Arithmetic runs on `Temporal.Instant`, which is exact-time: adding minutes to
 * an instant adds real elapsed minutes, never calendar minutes. That is the
 * correct semantics here — a 45-minute service takes 45 real minutes even if a
 * DST transition happens during it. (Local wall-clock expansion is a different
 * problem, handled where availability rules are expanded, not here.)
 */
export function buildBlockingRange(
  startsAt: Date | string | Temporal.Instant,
  service: ServiceTiming,
): BlockingRange {
  const start = toInstant(startsAt);

  const end = start.add({ minutes: service.durationMin });
  const blockingStart = start.subtract({ minutes: service.bufferBeforeMin });
  const blockingEnd = end.add({ minutes: service.bufferAfterMin });

  const startsAtDate = new Date(start.epochMilliseconds);
  const endsAtDate = new Date(end.epochMilliseconds);
  const blockingStartDate = new Date(blockingStart.epochMilliseconds);
  const blockingEndDate = new Date(blockingEnd.epochMilliseconds);

  return {
    startsAt: startsAtDate,
    endsAt: endsAtDate,
    blockingStart: blockingStartDate,
    blockingEnd: blockingEndDate,
    slot: toTstzRangeLiteral(blockingStartDate, blockingEndDate),
  };
}

function toInstant(value: Date | string | Temporal.Instant): Temporal.Instant {
  if (value instanceof Date) {
    return Temporal.Instant.fromEpochMilliseconds(value.getTime());
  }
  if (typeof value === "string") {
    return Temporal.Instant.from(value);
  }
  return value;
}
