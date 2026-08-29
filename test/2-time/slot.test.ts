import { describe, expect, it } from "vitest";

import {
  buildBlockingRange,
  toTstzRangeLiteral,
} from "@/lib/scheduling/slot";

/**
 * Pure tests for the range builder. No database — these check the arithmetic
 * and, above all, the BOUNDS. The database tests then prove the bounds mean
 * what we think they mean to Postgres.
 */

const utc = (hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 8, 15, hour, minute, 0, 0));

describe("toTstzRangeLiteral", () => {
  it("emits a lower-inclusive, upper-exclusive literal", () => {
    expect(toTstzRangeLiteral(utc(10), utc(11))).toBe(
      '["2026-09-15T10:00:00.000Z","2026-09-15T11:00:00.000Z")',
    );
  });

  it("uses [ and ) and never [ and ]", () => {
    const literal = toTstzRangeLiteral(utc(10), utc(11));
    expect(literal.startsWith("[")).toBe(true);
    expect(literal.endsWith(")")).toBe(true);
  });
});

describe("buildBlockingRange", () => {
  it("keeps customer-facing times equal to the service duration", () => {
    const range = buildBlockingRange(utc(10), {
      durationMin: 45,
      bufferBeforeMin: 0,
      bufferAfterMin: 0,
    });

    expect(range.startsAt).toEqual(utc(10));
    expect(range.endsAt).toEqual(utc(10, 45));
  });

  it("widens the blocking range by the buffers, leaving the visible times alone", () => {
    const range = buildBlockingRange(utc(10), {
      durationMin: 60,
      bufferBeforeMin: 15,
      bufferAfterMin: 30,
    });

    // What the customer is told.
    expect(range.startsAt).toEqual(utc(10));
    expect(range.endsAt).toEqual(utc(11));

    // What the calendar refuses to double-book.
    expect(range.blockingStart).toEqual(utc(9, 45));
    expect(range.blockingEnd).toEqual(utc(11, 30));
    expect(range.slot).toBe(
      '["2026-09-15T09:45:00.000Z","2026-09-15T11:30:00.000Z")',
    );
  });

  it("produces adjacent, non-overlapping ranges for back-to-back bookings", () => {
    const first = buildBlockingRange(utc(10), {
      durationMin: 60,
      bufferBeforeMin: 0,
      bufferAfterMin: 0,
    });
    const second = buildBlockingRange(utc(11), {
      durationMin: 60,
      bufferBeforeMin: 0,
      bufferAfterMin: 0,
    });

    // The upper bound of the first equals the lower bound of the second, which
    // is precisely the case that must NOT count as an overlap.
    expect(first.blockingEnd).toEqual(second.blockingStart);
  });

  it("accepts an ISO string as well as a Date", () => {
    const fromString = buildBlockingRange("2026-09-15T10:00:00.000Z", {
      durationMin: 30,
      bufferBeforeMin: 0,
      bufferAfterMin: 0,
    });

    expect(fromString.endsAt).toEqual(utc(10, 30));
  });

  it("adds real elapsed minutes, not calendar minutes, across a DST boundary", () => {
    // 2026-03-29 01:30 UTC is 02:30 in Berlin, half an hour before the spring
    // forward. A 60-minute service ends 60 real minutes later, at 02:30 UTC,
    // which is 04:30 local — the wall clock jumped, the duration did not.
    const range = buildBlockingRange("2026-03-29T01:30:00.000Z", {
      durationMin: 60,
      bufferBeforeMin: 0,
      bufferAfterMin: 0,
    });

    expect(range.endsAt.toISOString()).toBe("2026-03-29T02:30:00.000Z");
    expect(range.endsAt.getTime() - range.startsAt.getTime()).toBe(60 * 60_000);
  });
});
