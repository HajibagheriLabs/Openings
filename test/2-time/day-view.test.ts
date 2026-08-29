import { describe, expect, it } from "vitest";

import { nearestOffers, packOffers } from "@/lib/scheduling/day-view";
import type { DayOffer } from "@/lib/scheduling/day-view";

/**
 * Choosing which start times to draw.
 *
 * The engine offers every start the grid allows, and on a 15-minute grid with
 * a 90-minute service those overlap five deep. The Ribbon draws time to scale,
 * so overlapping segments are not a styling problem — they are undrawable. The
 * packing decides what the customer is shown, which makes it a product rule
 * with a test rather than a layout detail.
 */

/** Ascending starts every 15 minutes from 09:00 on a plain Tuesday. */
function grid(count: number, stepMin = 15, fromHour = 9) {
  return Array.from({ length: count }, (_, index) => {
    const start = Date.UTC(2026, 8, 15, fromHour, index * stepMin);

    return {
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(start + 90 * 60_000).toISOString(),
    };
  });
}

const at = (hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 8, 15, hour, minute)).toISOString();

describe("packOffers", () => {
  it("returns nothing for a day with nothing", () => {
    expect(packOffers([], 90)).toEqual([]);
  });

  it("takes the earliest start and then the next that does not overlap", () => {
    // 09:00, 09:15 … 17:45 — every quarter hour for nine hours.
    const packed = packOffers(grid(36), 90);

    expect(packed.map((slot) => slot.startsAt)).toEqual([
      at(9),
      at(10, 30),
      at(12),
      at(13, 30),
      at(15),
      at(16, 30),
    ]);
  });

  it("never invents a start the engine did not offer", () => {
    const slots = grid(36);
    const offered = new Set(slots.map((slot) => slot.startsAt));

    for (const slot of packOffers(slots, 90)) {
      expect(offered.has(slot.startsAt)).toBe(true);
    }
  });

  it("resumes on the grid after a gap, rather than on a multiple of the length", () => {
    /* An appointment ended at an awkward time, so the free interval starts at
       11:20 and the engine's next legal start is 11:30. The packing has to
       follow the day, not its own arithmetic. */
    const slots = [
      { startsAt: at(9), endsAt: at(10, 30) },
      { startsAt: at(11, 30), endsAt: at(13) },
      { startsAt: at(11, 45), endsAt: at(13, 15) },
      { startsAt: at(13), endsAt: at(14, 30) },
    ];

    expect(packOffers(slots, 90).map((slot) => slot.startsAt)).toEqual([
      at(9),
      at(11, 30),
      at(13),
    ]);
  });

  it("keeps the anchored slot, and builds outwards from it", () => {
    /* The customer is holding 09:45, which unanchored packing would skip. It
       has to survive, or their own slot would vanish from the drawing the
       moment they took it. */
    const packed = packOffers(grid(36), 90, at(9, 45));

    expect(packed.map((slot) => slot.startsAt)).toContain(at(9, 45));
    expect(packed.map((slot) => slot.startsAt)).toEqual([
      at(9, 45),
      at(11, 15),
      at(12, 45),
      at(14, 15),
      at(15, 45),
      at(17, 15),
    ]);
  });

  it("packs backwards from an anchor late in the day", () => {
    const packed = packOffers(grid(36), 90, at(15));

    expect(packed.map((slot) => slot.startsAt)).toEqual([
      at(9),
      at(10, 30),
      at(12),
      at(13, 30),
      at(15),
      at(16, 30),
    ]);
  });

  it("ignores an anchor that is not on offer", () => {
    const packed = packOffers(grid(36), 90, at(3));

    expect(packed[0].startsAt).toBe(at(9));
  });

  it("never draws two segments that overlap", () => {
    const packed = packOffers(grid(36), 90);

    for (let index = 1; index < packed.length; index += 1) {
      expect(Date.parse(packed[index].startsAt)).toBeGreaterThanOrEqual(
        Date.parse(packed[index - 1].startsAt) + 90 * 60_000,
      );
    }
  });
});

describe("nearestOffers", () => {
  const offer = (hour: number, minute = 0): DayOffer => ({
    id: at(hour, minute),
    startsAt: at(hour, minute),
    endsAt: at(hour + 1, minute),
    startMinute: hour * 60 + minute,
    durationMin: 60,
    staffIds: ["staff-1"],
  });

  it("picks the two closest by distance, not the two after", () => {
    /* Somebody who had decided on two o'clock is better served by one o'clock
       than by five. Nearest means nearest in both directions. */
    const offers = [offer(9), offer(13), offer(17), offer(18)];

    expect(
      nearestOffers(offers, at(14)).map((slot) => slot.startsAt),
    ).toEqual([at(13), at(17)]);
  });

  it("returns them in time order, whichever was closer", () => {
    const offers = [offer(13), offer(15)];
    const nearest = nearestOffers(offers, at(14, 30));

    // 15:00 is closer, but a list of times reads forwards.
    expect(nearest.map((slot) => slot.startsAt)).toEqual([at(13), at(15)]);
  });

  it("copes with a day that has fewer than two left", () => {
    expect(nearestOffers([offer(9)], at(14))).toHaveLength(1);
    expect(nearestOffers([], at(14))).toEqual([]);
  });

  it("does not mutate the list it was given", () => {
    const offers = [offer(17), offer(9)];
    nearestOffers(offers, at(14));

    expect(offers.map((slot) => slot.startsAt)).toEqual([at(17), at(9)]);
  });
});
