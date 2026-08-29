import "server-only";

import type { Db } from "@/db/client";

import { getAvailability, type ShapeSpan } from "./availability";
import { ceilHour, floorHour, localMinuteOf } from "./local-minutes";
import { Temporal, type TimeZoneId } from "./temporal";

/**
 * One day, ready to be drawn.
 *
 * This is the bridge between the availability engine and the Ribbon, and it is
 * where the two things the customer needs get separated:
 *
 *   OFFERS — the times they can actually take.
 *   BLOCKS — the rest of the day, so the offers have somewhere to sit.
 *
 * A picker that draws only the offers is four buttons floating in space, and
 * four buttons cannot tell you whether the shop is nearly empty or nearly
 * full. Drawing the taken time as material — hatched, or carved in — turns the
 * same list into a day you can read at a glance, and makes "only two left"
 * something the customer can see rather than something we assert.
 *
 * EVERY NUMBER HERE IS COMPUTED ON THE SERVER, in the business's timezone. The
 * Ribbon receives minutes and instants and does no arithmetic at all.
 */

/** A start time the customer may take. */
export interface DayOffer {
  /**
   * The ISO start instant, used as the id.
   *
   * Stable across polls by construction: the same minute of the same day is
   * the same string, so React keeps the element, the 240ms fade to hatched
   * plays on the element the customer was looking at, and "the slot you had
   * focused just went" is answerable without a client-side registry.
   */
  id: string;
  startsAt: string;
  endsAt: string;
  /** Minutes since local midnight. See the note on `localMinuteOf`. */
  startMinute: number;
  /** Customer-facing length — what gets drawn. */
  durationMin: number;
  /** Everyone free at this instant. One entry when a person was chosen. */
  staffIds: string[];
}

/** Time inside opening hours that is not on offer. */
export interface DayBlock {
  id: string;
  startsAt: string;
  endsAt: string;
  startMinute: number;
  durationMin: number;
  /** `busy` is an appointment or a live hold; `closed` is time off. */
  kind: "busy" | "closed";
}

export interface DayView {
  /** Local calendar date in the business timezone, "2026-09-03". */
  date: string;
  timeZone: TimeZoneId;
  /** An instant on that day, for formatting the heading. */
  dayInstant: string;
  /** The slice of the day to draw, in minutes since local midnight. */
  window: { startMinute: number; endMinute: number };
  /** Where the now line goes, or null when the day is not today. */
  nowMinute: number | null;
  offers: DayOffer[];
  blocks: DayBlock[];
  /**
   * How many start times the engine produced before packing.
   *
   * Reported so the copy can be honest about the difference — see the note on
   * `packOffers`.
   */
  grantedStarts: number;
  /** True when the business publishes no hours at all on this day. */
  closed: boolean;
}

export interface DayViewRequest {
  db: Db;
  businessId: string;
  serviceId: string;
  staffId: string | "any";
  timeZone: TimeZoneId;
  /** Local calendar date in the business timezone. */
  date: string;
  /** Injected clock. */
  now?: Date;
  /**
   * The visitor's own hold, if they have one on this day. Availability is
   * computed as if it were not there, so their own slot comes back as
   * offerable rather than as taken by a stranger.
   */
  excludeAppointmentId?: string;
  /**
   * Start instant of that hold. Used to ANCHOR the packing, so the slot the
   * customer is holding is always one of the drawn offers rather than
   * something the layout happened to skip.
   */
  anchorStartsAt?: string;
}

/*
 * `localMinuteOf`, `floorHour` and `ceilHour` moved to ./local-minutes.ts when
 * the admin agenda started drawing the same ruler. The picker and the calendar
 * have to agree, to the minute, about where nine o'clock is; two copies of that
 * arithmetic would eventually disagree on exactly the day it matters.
 */

/**
 * Choose which of the engine's start times to DRAW.
 *
 * THE PROBLEM. With a 15-minute grid and a 90-minute service, a nine-hour day
 * yields twenty-nine bookable starts — 09:00, 09:15, 09:30 and so on — and
 * every one of them overlaps the five after it. There is no way to draw
 * twenty-nine overlapping 90-minute blocks on a strip whose entire purpose is
 * that a block's height IS its length. Something has to give, and it cannot be
 * the proportionality.
 *
 * THE CHOICE. Draw a maximal set of NON-OVERLAPPING starts: take the earliest,
 * then the earliest that begins at or after the previous one ends, and so on.
 * Every offer is a real slot the engine produced — nothing is invented — and
 * the set tiles each free interval, so the drawing reads as "here is the day,
 * here is how your appointment fits into it".
 *
 * WHAT IT COSTS, SAID OUT LOUD. A customer who wants 09:15 when 09:00 and
 * 10:30 are drawn cannot have it from this screen. That is a real narrowing,
 * and it is the reason `grantedStarts` is reported: the copy says how many
 * times exist. Granularity still does the work that matters, because packing
 * resumes at the start of every free interval — after an appointment ending at
 * 11:20 on a 15-minute grid, the next offer is 11:30, not 11:00 plus a
 * multiple of ninety.
 *
 * `anchor` pins the packing to a slot that must appear whatever else does —
 * the one the customer is already holding. The set is built outwards from it
 * so their own choice is never the slot the layout skipped.
 */
export function packOffers<T extends { startsAt: string; endsAt: string }>(
  slots: T[],
  durationMin: number,
  anchor?: string,
): T[] {
  if (slots.length === 0) {
    return [];
  }

  const lengthMs = durationMin * 60_000;
  const at = (slot: T) => Date.parse(slot.startsAt);

  const anchorIndex = anchor
    ? slots.findIndex((slot) => slot.startsAt === anchor)
    : -1;

  const start = anchorIndex >= 0 ? anchorIndex : 0;
  const chosen: T[] = [slots[start]];

  // Forward from the anchor: the next start that does not overlap the last.
  let lastEnd = at(slots[start]) + lengthMs;

  for (let index = start + 1; index < slots.length; index += 1) {
    if (at(slots[index]) >= lastEnd) {
      chosen.push(slots[index]);
      lastEnd = at(slots[index]) + lengthMs;
    }
  }

  // Backward from the anchor, for the part of the day before it.
  let firstStart = at(slots[start]);

  for (let index = start - 1; index >= 0; index -= 1) {
    if (at(slots[index]) + lengthMs <= firstStart) {
      chosen.unshift(slots[index]);
      firstStart = at(slots[index]);
    }
  }

  return chosen;
}

/**
 * What `loadDayView` hands back.
 *
 * `view` is what the browser gets. `starts` is every start the POLICY allows
 * on this day — lead time, opening hours, closures, the lot — and it never
 * leaves the server: it is what an action checks a posted `startsAt` against,
 * so a hand-rolled request cannot hold three in the morning. The exclusion
 * constraint stops double-booking; this stops booking outside the day
 * altogether, which is a different question and not one a constraint answers.
 */
export interface DayViewResult {
  view: DayView;
  starts: Set<string>;
  /** Everyone who could perform the service at a given start. */
  staffAt: Map<string, string[]>;
}

/** Load and shape one day. Null when the service is not this business's. */
export async function loadDayView(
  request: DayViewRequest,
): Promise<DayViewResult | null> {
  const { db, timeZone, date } = request;
  const clock = request.now ?? new Date();

  const result = await getAvailability({
    db,
    businessId: request.businessId,
    serviceId: request.serviceId,
    staffId: request.staffId,
    from: date,
    to: date,
    now: clock,
    excludeAppointmentId: request.excludeAppointmentId,
  });

  if (!result) {
    return null;
  }

  const minuteOf = (instant: string) => localMinuteOf(instant, date, timeZone);

  /* The engine was asked for exactly one local day, so everything it returns
     already belongs to it — no second clip is needed here. */
  const offers: DayOffer[] = packOffers(
    result.slots,
    result.durationMin,
    request.anchorStartsAt,
  ).map((slot) => ({
    id: slot.startsAt,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    startMinute: minuteOf(slot.startsAt),
    durationMin: result.durationMin,
    staffIds: slot.staffIds,
  }));

  const toBlock = (kind: DayBlock["kind"]) => (span: ShapeSpan) => ({
    id: `${kind}-${span.startsAt}`,
    startsAt: span.startsAt,
    endsAt: span.endsAt,
    startMinute: minuteOf(span.startsAt),
    durationMin: Math.round(
      (Date.parse(span.endsAt) - Date.parse(span.startsAt)) / 60_000,
    ),
    kind,
  });

  const blocks: DayBlock[] = [
    ...result.shape.busy.map(toBlock("busy")),
    ...result.shape.closed.map(toBlock("closed")),
  ].sort((a, b) => a.startMinute - b.startMinute);

  /* The window is the published day, rounded out to whole hours so the ruler
     starts on the clock. Widened to include anything drawn — a booking whose
     buffer reaches past closing has to have somewhere to sit. */
  const edges = [
    ...result.shape.hours.flatMap((span) => [
      minuteOf(span.startsAt),
      minuteOf(span.endsAt),
    ]),
    ...blocks.flatMap((block) => [
      block.startMinute,
      block.startMinute + block.durationMin,
    ]),
    ...offers.flatMap((offer) => [
      offer.startMinute,
      offer.startMinute + offer.durationMin,
    ]),
  ];

  const closed = result.shape.hours.length === 0;

  const window = closed
    ? { startMinute: 9 * 60, endMinute: 18 * 60 }
    : {
        startMinute: floorHour(Math.min(...edges)),
        endMinute: ceilHour(Math.max(...edges)),
      };

  /* The now line belongs on today and nowhere else. A day next month has no
     "now", and drawing one would be a line across a fiction. */
  const todayLocal = Temporal.Instant.fromEpochMilliseconds(clock.getTime())
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString();

  const nowMinute =
    todayLocal === date ? minuteOf(clock.toISOString()) : null;

  return {
    view: {
      date,
      timeZone,
      dayInstant: Temporal.PlainDate.from(date)
        .toZonedDateTime({
          timeZone,
          plainTime: Temporal.PlainTime.from("12:00"),
        })
        .toInstant()
        .toString(),
      window,
      nowMinute,
      offers,
      blocks,
      grantedStarts: result.slots.length,
      closed,
    },
    starts: new Set(result.slots.map((slot) => slot.startsAt)),
    staffAt: new Map(
      result.slots.map((slot) => [slot.startsAt, slot.staffIds]),
    ),
  };
}

/**
 * The two openings nearest a time that has just gone.
 *
 * Used for "That time was just booked. Here are the nearest openings." —
 * nearest by absolute distance from what they wanted, so an hour earlier beats
 * three hours later, which is what somebody who had already decided on two
 * o'clock actually wants to hear.
 */
export function nearestOffers(
  offers: DayOffer[],
  wantedStartsAt: string,
  count = 2,
): DayOffer[] {
  const wanted = Date.parse(wantedStartsAt);

  return [...offers]
    .sort(
      (a, b) =>
        Math.abs(Date.parse(a.startsAt) - wanted) -
        Math.abs(Date.parse(b.startsAt) - wanted),
    )
    .slice(0, count)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}
