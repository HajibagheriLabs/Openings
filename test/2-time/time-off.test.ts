import { describe, expect, it } from "vitest";

import {
  countLocalDays,
  coversWholeLocalDays,
  resolveTimeOffRange,
} from "@/lib/scheduling/time-off";

/**
 * THE ALL-DAY BUG, PINNED DOWN.
 *
 * "Closed on 25 December" is a LOCAL day. Two implementations look right and
 * are wrong, both silently:
 *
 *   UTC midnight — blocks 01:00 to 01:00 in Berlin, so Boxing Day morning is
 *   closed and Christmas Eve evening stays bookable.
 *
 *   start + 24 hours — right on 363 days a year. On the two DST days a local
 *   day is 23 or 25 hours, so the block lands an hour short or an hour long.
 *
 * Every test below would pass against a naive implementation on an ordinary
 * day. The ones that matter are the DST ones, which is why they are here.
 */

const BERLIN = "Europe/Berlin";
const AUCKLAND = "Pacific/Auckland";

/** Berlin: +01:00 in winter, +02:00 in summer. */
const HOUR = 3_600_000;

function resolve(input: Parameters<typeof resolveTimeOffRange>[0], tz: string) {
  const result = resolveTimeOffRange(input, tz);

  if (!result.ok) {
    throw new Error(`expected a resolved range, got: ${result.message}`);
  }

  return result.value;
}

describe("all-day ranges resolve to local day boundaries", () => {
  it("starts at local midnight, not UTC midnight", () => {
    const { startsAt, endsAt } = resolve(
      { startDate: "2026-12-25", endDate: "2026-12-25", isAllDay: true },
      BERLIN,
    );

    // Berlin is +01:00 in December, so local midnight is 23:00 UTC the day
    // before. A UTC-midnight implementation would say 2026-12-25T00:00:00Z.
    expect(startsAt.toISOString()).toBe("2026-12-24T23:00:00.000Z");
    expect(endsAt.toISOString()).toBe("2026-12-25T23:00:00.000Z");
  });

  it("covers exactly one local day", () => {
    const { startsAt, endsAt } = resolve(
      { startDate: "2026-12-25", endDate: "2026-12-25", isAllDay: true },
      BERLIN,
    );

    expect(endsAt.getTime() - startsAt.getTime()).toBe(24 * HOUR);
    expect(countLocalDays(startsAt, endsAt, BERLIN)).toBe(1);
  });

  it("ends at the start of the day AFTER the last day, exclusively", () => {
    const { endsAt } = resolve(
      { startDate: "2026-12-24", endDate: "2026-12-26", isAllDay: true },
      BERLIN,
    );

    // The 27th at local midnight — so an appointment at 00:00 on the 27th is
    // untouched, and the 26th is fully covered.
    expect(endsAt.toISOString()).toBe("2026-12-26T23:00:00.000Z");
  });

  it("counts a multi-day closure in calendar days", () => {
    const { startsAt, endsAt } = resolve(
      { startDate: "2026-12-24", endDate: "2026-12-26", isAllDay: true },
      BERLIN,
    );

    expect(countLocalDays(startsAt, endsAt, BERLIN)).toBe(3);
  });

  /**
   * SPRING FORWARD. 29 March 2026, Berlin: 02:00 becomes 03:00, so the local
   * day is 23 HOURS LONG. `start + PT24H` would end at 01:00 on the 30th and
   * leave the last hour of the closed day bookable.
   */
  it("covers a 23-hour local day on spring forward", () => {
    const { startsAt, endsAt } = resolve(
      { startDate: "2026-03-29", endDate: "2026-03-29", isAllDay: true },
      BERLIN,
    );

    expect(endsAt.getTime() - startsAt.getTime()).toBe(23 * HOUR);
    expect(startsAt.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(endsAt.toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(countLocalDays(startsAt, endsAt, BERLIN)).toBe(1);
  });

  /**
   * FALL BACK. 25 October 2026, Berlin: 03:00 becomes 02:00, so the local day
   * is 25 HOURS LONG. `start + PT24H` would end at 23:00 local and leave the
   * last hour of the closed day open.
   */
  it("covers a 25-hour local day on fall back", () => {
    const { startsAt, endsAt } = resolve(
      { startDate: "2026-10-25", endDate: "2026-10-25", isAllDay: true },
      BERLIN,
    );

    expect(endsAt.getTime() - startsAt.getTime()).toBe(25 * HOUR);
    expect(startsAt.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(endsAt.toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect(countLocalDays(startsAt, endsAt, BERLIN)).toBe(1);
  });

  it("spans a DST boundary inside a multi-day closure without drifting", () => {
    const { startsAt, endsAt } = resolve(
      { startDate: "2026-03-28", endDate: "2026-03-30", isAllDay: true },
      BERLIN,
    );

    // Three local days, one of which is 23 hours: 71 hours, not 72.
    expect(endsAt.getTime() - startsAt.getTime()).toBe(71 * HOUR);
    expect(countLocalDays(startsAt, endsAt, BERLIN)).toBe(3);
  });

  /** A zone on the other side of the date line, to prove nothing is hardcoded. */
  it("resolves in a southern-hemisphere zone too", () => {
    const { startsAt } = resolve(
      { startDate: "2026-12-25", endDate: "2026-12-25", isAllDay: true },
      AUCKLAND,
    );

    // Auckland is +13:00 in December, so its local midnight is the 24th, 11:00 UTC.
    expect(startsAt.toISOString()).toBe("2026-12-24T11:00:00.000Z");
  });
});

describe("part-day ranges", () => {
  it("uses the local times given, in the business zone", () => {
    const { startsAt, endsAt } = resolve(
      {
        startDate: "2026-07-01",
        endDate: "2026-07-01",
        startLocal: "13:00",
        endLocal: "17:00",
        isAllDay: false,
      },
      BERLIN,
    );

    // +02:00 in July.
    expect(startsAt.toISOString()).toBe("2026-07-01T11:00:00.000Z");
    expect(endsAt.toISOString()).toBe("2026-07-01T15:00:00.000Z");
  });

  it("allows a block that runs overnight across two dates", () => {
    const { startsAt, endsAt } = resolve(
      {
        startDate: "2026-07-01",
        endDate: "2026-07-02",
        startLocal: "22:00",
        endLocal: "02:00",
        isAllDay: false,
      },
      BERLIN,
    );

    expect(endsAt.getTime() - startsAt.getTime()).toBe(4 * HOUR);
  });

  it("refuses a range that ends before it starts", () => {
    const result = resolveTimeOffRange(
      {
        startDate: "2026-07-01",
        endDate: "2026-07-01",
        startLocal: "17:00",
        endLocal: "13:00",
        isAllDay: false,
      },
      BERLIN,
    );

    expect(result.ok).toBe(false);
  });

  it("refuses an empty range", () => {
    const result = resolveTimeOffRange(
      {
        startDate: "2026-07-01",
        endDate: "2026-07-01",
        startLocal: "13:00",
        endLocal: "13:00",
        isAllDay: false,
      },
      BERLIN,
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("empty-range");
  });

  it("refuses a last day before the first day", () => {
    const result = resolveTimeOffRange(
      { startDate: "2026-07-02", endDate: "2026-07-01", isAllDay: true },
      BERLIN,
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("end-before-start");
  });
});

describe("range literals", () => {
  it("is half-open, so a closure and the next day do not collide", () => {
    const { range } = resolve(
      { startDate: "2026-12-25", endDate: "2026-12-25", isAllDay: true },
      BERLIN,
    );

    expect(range.startsWith("[")).toBe(true);
    expect(range.endsWith(")")).toBe(true);
  });
});

describe("coversWholeLocalDays", () => {
  it("recognises an all-day range", () => {
    const { startsAt, endsAt } = resolve(
      { startDate: "2026-10-25", endDate: "2026-10-25", isAllDay: true },
      BERLIN,
    );

    expect(coversWholeLocalDays(startsAt, endsAt, BERLIN)).toBe(true);
  });

  it("does not mistake a part-day range for a whole day", () => {
    const { startsAt, endsAt } = resolve(
      {
        startDate: "2026-07-01",
        endDate: "2026-07-01",
        startLocal: "09:00",
        endLocal: "17:00",
        isAllDay: false,
      },
      BERLIN,
    );

    expect(coversWholeLocalDays(startsAt, endsAt, BERLIN)).toBe(false);
  });

  /**
   * The same instants read in a DIFFERENT zone are not whole days there. This
   * is the reason the judgement takes a timezone instead of looking at the
   * numbers.
   */
  it("is a judgement about a specific timezone, not about the instants", () => {
    const { startsAt, endsAt } = resolve(
      { startDate: "2026-12-25", endDate: "2026-12-25", isAllDay: true },
      BERLIN,
    );

    expect(coversWholeLocalDays(startsAt, endsAt, AUCKLAND)).toBe(false);
  });
});
