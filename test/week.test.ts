import { describe, expect, it } from "vitest";

import {
  crossesMidnight,
  findOverlappingIntervals,
  formatLocalMinuteRange,
  formatLocalMinutes,
  intervalLength,
  parseLocalTime,
  splitIntoDaySpans,
  toWeekSpan,
  weekSpansOverlap,
  weekWindow,
  type LocalInterval,
} from "@/lib/scheduling/week";
import { weeklyHoursSchema } from "@/lib/validation/hours";

/**
 * MIDNIGHT-CROSSING SHIFTS ARE SUPPORTED, and this file is the "and tested"
 * half of that decision.
 *
 * The schema documents `end_local < start_local` as "carries into the next
 * day", so a night shift is expressible without a special case. The cost is
 * that overlap can no longer be checked one weekday at a time — a Monday
 * 22:00–02:00 occupies part of Tuesday — and getting that wrong would let two
 * overlapping rules into the database, where the availability expansion would
 * silently offer the same minutes twice.
 */

const interval = (
  weekday: number,
  startLocal: string,
  endLocal: string,
): LocalInterval => ({ weekday, startLocal, endLocal });

describe("wall-clock parsing", () => {
  it("reads and writes a time as minutes past midnight", () => {
    expect(parseLocalTime("09:30")).toBe(570);
    expect(formatLocalMinutes(570)).toBe("09:30");
  });

  it("refuses anything that is not a 24-hour wall clock", () => {
    expect(parseLocalTime("24:00")).toBeNull();
    expect(parseLocalTime("9:30")).toBeNull();
    expect(parseLocalTime("")).toBeNull();
  });

  /** The end of a night shift reads "02:00", never "26:00". */
  it("wraps a minute past the end of the day back onto the clock face", () => {
    expect(formatLocalMinutes(1560)).toBe("02:00");
    expect(formatLocalMinuteRange(1320, 240)).toBe("22:00 – 02:00");
  });
});

describe("intervalLength", () => {
  it("measures an ordinary interval", () => {
    expect(intervalLength(540, 1020)).toBe(480);
  });

  it("carries a midnight-crossing interval into the next day", () => {
    // 22:00 to 02:00 is four hours, not a negative twenty.
    expect(intervalLength(1320, 120)).toBe(240);
  });

  /**
   * Equal start and end is REFUSED rather than read as 24 hours. A silent
   * 1440-minute interval would swallow the whole day's availability while
   * looking perfectly ordinary in the form.
   */
  it("refuses an interval whose end equals its start", () => {
    expect(intervalLength(540, 540)).toBeNull();
  });
});

describe("weekSpansOverlap", () => {
  it("treats touching intervals as not overlapping", () => {
    // This is what makes a lunch break two ordinary adjacent intervals rather
    // than a special "break" concept.
    const morning = toWeekSpan(interval(1, "09:00", "13:00"))!;
    const afternoon = toWeekSpan(interval(1, "13:00", "18:00"))!;

    expect(weekSpansOverlap(morning, afternoon)).toBe(false);
  });

  it("catches a plain same-day overlap", () => {
    const a = toWeekSpan(interval(1, "09:00", "13:00"))!;
    const b = toWeekSpan(interval(1, "12:00", "18:00"))!;

    expect(weekSpansOverlap(a, b)).toBe(true);
  });

  it("keeps the same times on different days apart", () => {
    const monday = toWeekSpan(interval(1, "09:00", "17:00"))!;
    const tuesday = toWeekSpan(interval(2, "09:00", "17:00"))!;

    expect(weekSpansOverlap(monday, tuesday)).toBe(false);
  });

  /** The case that per-weekday checking would miss entirely. */
  it("catches a night shift colliding with the next morning", () => {
    const mondayNight = toWeekSpan(interval(1, "22:00", "02:00"))!;
    const tuesdayEarly = toWeekSpan(interval(2, "01:00", "09:00"))!;

    expect(weekSpansOverlap(mondayNight, tuesdayEarly)).toBe(true);
  });

  it("lets a night shift end exactly where the next day begins", () => {
    const mondayNight = toWeekSpan(interval(1, "22:00", "02:00"))!;
    const tuesdayMorning = toWeekSpan(interval(2, "02:00", "09:00"))!;

    expect(weekSpansOverlap(mondayNight, tuesdayMorning)).toBe(false);
  });

  /**
   * Saturday night runs into Sunday, which in week-minute terms is minute 0 of
   * the SAME week rather than minute 10080 of the next. Without unrolling the
   * wrap, this pair would test as disjoint.
   */
  it("wraps the end of the week around to its beginning", () => {
    const saturdayNight = toWeekSpan(interval(6, "23:00", "03:00"))!;
    const sundayEarly = toWeekSpan(interval(0, "01:00", "05:00"))!;

    expect(weekSpansOverlap(saturdayNight, sundayEarly)).toBe(true);
  });
});

describe("findOverlappingIntervals", () => {
  it("finds nothing in a well-formed week", () => {
    expect(
      findOverlappingIntervals([
        interval(1, "09:00", "13:00"),
        interval(1, "14:00", "18:00"),
        interval(2, "09:00", "17:00"),
      ]),
    ).toEqual([]);
  });

  it("reports the indexes of both offenders", () => {
    const pairs = findOverlappingIntervals([
      interval(1, "09:00", "13:00"),
      interval(2, "09:00", "17:00"),
      interval(1, "12:00", "15:00"),
    ]);

    expect(pairs).toEqual([{ first: 0, second: 2 }]);
  });
});

describe("splitIntoDaySpans", () => {
  it("leaves an ordinary interval in one piece", () => {
    const spans = splitIntoDaySpans([interval(1, "09:00", "17:00")]);

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      weekday: 1,
      startMinute: 540,
      durationMin: 480,
      isContinuation: false,
    });
  });

  /** A night shift is drawn in the two days it genuinely occupies. */
  it("cuts a midnight-crossing interval into two days", () => {
    const spans = splitIntoDaySpans([interval(1, "22:00", "02:00")]);

    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({
      weekday: 1,
      startMinute: 1320,
      durationMin: 120,
      isContinuation: false,
    });
    expect(spans[1]).toMatchObject({
      weekday: 2,
      startMinute: 0,
      durationMin: 120,
      isContinuation: true,
    });
    // Both pieces carry the whole interval's label, not their own fragment.
    expect(spans[1].label).toBe("22:00 – 02:00");
  });

  it("carries a Saturday night shift onto Sunday, not onto day 7", () => {
    const spans = splitIntoDaySpans([interval(6, "23:00", "01:00")]);

    expect(spans[1].weekday).toBe(0);
  });
});

describe("weekWindow", () => {
  it("pads the configured hours out to the hour on each side", () => {
    const spans = splitIntoDaySpans([interval(1, "09:30", "17:15")]);

    // 09:30 back an hour and down to the hour is 08:00; 17:15 forward an hour
    // and up to the hour is 19:00. The padding is what keeps a segment from
    // sitting flush against the edge of the ribbon.
    expect(weekWindow(spans)).toEqual({ startMinute: 480, endMinute: 1140 });
  });

  it("falls back to a plain working day when nothing is configured", () => {
    expect(weekWindow([])).toEqual({ startMinute: 480, endMinute: 1200 });
  });
});

describe("crossesMidnight", () => {
  it("is true only when the end is earlier than the start", () => {
    expect(crossesMidnight(interval(1, "22:00", "02:00"))).toBe(true);
    expect(crossesMidnight(interval(1, "09:00", "17:00"))).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
   The schema, which is the boundary that actually refuses a bad week
--------------------------------------------------------------------------- */

function week(
  overrides: Partial<Record<number, { startLocal: string; endLocal: string }[]>>,
) {
  return {
    staffId: "3f1d2b4e-8c9a-4b7d-9e2f-1a2b3c4d5e6f",
    effectiveFrom: "2026-09-01",
    days: Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      intervals: overrides[weekday] ?? [],
    })),
  };
}

describe("weeklyHoursSchema", () => {
  it("accepts a week with a lunch break as two intervals", () => {
    const result = weeklyHoursSchema.safeParse(
      week({
        1: [
          { startLocal: "09:00", endLocal: "13:00" },
          { startLocal: "14:00", endLocal: "18:00" },
        ],
      }),
    );

    expect(result.success).toBe(true);
  });

  /**
   * "Closed" is the absence of a row, so an all-closed week would write
   * nothing and leave the previous version silently in force. Refusing it is
   * what stops a save that appears to work and does not.
   */
  it("rejects a week with every day closed, and says what to use instead", () => {
    const result = weeklyHoursSchema.safeParse(week({}));

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain("Time off");
  });

  it("accepts a week open on a single day", () => {
    const result = weeklyHoursSchema.safeParse(
      week({ 3: [{ startLocal: "10:00", endLocal: "14:00" }] }),
    );

    expect(result.success).toBe(true);
  });

  it("accepts a night shift", () => {
    const result = weeklyHoursSchema.safeParse(
      week({ 1: [{ startLocal: "22:00", endLocal: "06:00" }] }),
    );

    expect(result.success).toBe(true);
  });

  it("rejects overlapping intervals on one day, naming both", () => {
    const result = weeklyHoursSchema.safeParse(
      week({
        1: [
          { startLocal: "09:00", endLocal: "13:00" },
          { startLocal: "12:00", endLocal: "18:00" },
        ],
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain("09:00–13:00");
    expect(result.error?.issues[0].message).toContain("12:00–18:00");
  });

  /**
   * The whole reason overlap is checked in week-minutes. A per-weekday check
   * would call this week valid.
   */
  it("rejects a night shift that runs into the next day's hours", () => {
    const result = weeklyHoursSchema.safeParse(
      week({
        1: [{ startLocal: "22:00", endLocal: "02:00" }],
        2: [{ startLocal: "01:00", endLocal: "09:00" }],
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain("past midnight");
    expect(result.error?.issues[0].message).toContain("Tuesday");
  });

  it("allows a night shift that ends exactly when the next day opens", () => {
    const result = weeklyHoursSchema.safeParse(
      week({
        1: [{ startLocal: "22:00", endLocal: "02:00" }],
        2: [{ startLocal: "02:00", endLocal: "09:00" }],
      }),
    );

    expect(result.success).toBe(true);
  });

  it("rejects an interval whose end equals its start", () => {
    const result = weeklyHoursSchema.safeParse(
      week({ 1: [{ startLocal: "09:00", endLocal: "09:00" }] }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain("differ");
  });

  it("rejects a week that does not have all seven days", () => {
    const value = week({});
    value.days = value.days.slice(0, 6);

    expect(weeklyHoursSchema.safeParse(value).success).toBe(false);
  });
});
