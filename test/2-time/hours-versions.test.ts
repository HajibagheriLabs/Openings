import { describe, expect, it } from "vitest";

import {
  groupIntoVersions,
  previousDay,
  weeklyMinutesOf,
  type AvailabilityRuleRow,
} from "@/lib/scheduling/hours-versions";

/**
 * Effective dating, which is how hours change without rewriting history.
 *
 * The failure this guards against is quiet and nasty: if an edit overwrote the
 * single set of rules, every past day would retroactively claim hours it never
 * had, and last month's agenda would redraw itself. So hours are VERSIONS, and
 * the arithmetic that decides which version governs a given day has to be
 * exactly right on the changeover day — the one place an off-by-one lives.
 */

const rule = (
  effectiveFrom: string,
  weekday: number,
  startLocal: string,
  endLocal: string,
): AvailabilityRuleRow => ({
  staffId: "staff-1",
  weekday,
  startLocal: `${startLocal}:00`,
  endLocal: `${endLocal}:00`,
  effectiveFrom,
});

describe("groupIntoVersions", () => {
  it("returns nothing when there are no rules", () => {
    expect(groupIntoVersions([], "2026-08-21")).toEqual([]);
  });

  it("groups rules sharing a start date into one version", () => {
    const versions = groupIntoVersions(
      [
        rule("2026-01-01", 1, "09:00", "17:00"),
        rule("2026-01-01", 2, "09:00", "17:00"),
      ],
      "2026-08-21",
    );

    expect(versions).toHaveLength(1);
    expect(versions[0].days[1].intervals).toEqual([
      { startLocal: "09:00", endLocal: "17:00" },
    ]);
    expect(versions[0].weeklyMinutes).toBe(960);
  });

  it("keeps a day's intervals in clock order however they arrive", () => {
    const versions = groupIntoVersions(
      [
        rule("2026-01-01", 1, "14:00", "18:00"),
        rule("2026-01-01", 1, "09:00", "13:00"),
      ],
      "2026-08-21",
    );

    expect(versions[0].days[1].intervals.map((i) => i.startLocal)).toEqual([
      "09:00",
      "14:00",
    ]);
  });

  /** The derived boundary: a version ends the day before the next begins. */
  it("closes each version the day before the next one starts", () => {
    const versions = groupIntoVersions(
      [
        rule("2026-01-01", 1, "09:00", "17:00"),
        rule("2026-10-01", 1, "08:00", "16:00"),
      ],
      "2026-08-21",
    );

    expect(versions[0].effectiveTo).toBe("2026-09-30");
    expect(versions[1].effectiveTo).toBeNull();
  });

  it("orders versions oldest first regardless of row order", () => {
    const versions = groupIntoVersions(
      [
        rule("2026-10-01", 1, "08:00", "16:00"),
        rule("2026-01-01", 1, "09:00", "17:00"),
      ],
      "2026-08-21",
    );

    expect(versions.map((version) => version.effectiveFrom)).toEqual([
      "2026-01-01",
      "2026-10-01",
    ]);
  });

  it("marks exactly one version as in force", () => {
    const versions = groupIntoVersions(
      [
        rule("2026-01-01", 1, "09:00", "17:00"),
        rule("2026-06-01", 1, "08:00", "16:00"),
        rule("2026-10-01", 1, "07:00", "15:00"),
      ],
      "2026-08-21",
    );

    expect(versions.map((version) => version.isCurrent)).toEqual([
      false,
      true,
      false,
    ]);
    expect(versions.map((version) => version.isPast)).toEqual([
      true,
      false,
      false,
    ]);
    expect(versions.map((version) => version.isFuture)).toEqual([
      false,
      false,
      true,
    ]);
  });

  /**
   * THE CHANGEOVER DAY. A version starting today takes over TODAY, so the one
   * before it is already past. Reading the boundary as `today <= next` would
   * show two versions in force at once, every single time hours change.
   */
  it("hands over on the day the new version starts", () => {
    const versions = groupIntoVersions(
      [
        rule("2026-01-01", 1, "09:00", "17:00"),
        rule("2026-08-21", 1, "08:00", "16:00"),
      ],
      "2026-08-21",
    );

    expect(versions[0].isCurrent).toBe(false);
    expect(versions[0].isPast).toBe(true);
    expect(versions[1].isCurrent).toBe(true);
    expect(versions[1].isFuture).toBe(false);
  });

  it("leaves the day before the changeover with the old version", () => {
    const versions = groupIntoVersions(
      [
        rule("2026-01-01", 1, "09:00", "17:00"),
        rule("2026-08-21", 1, "08:00", "16:00"),
      ],
      "2026-08-20",
    );

    expect(versions[0].isCurrent).toBe(true);
    expect(versions[1].isFuture).toBe(true);
  });

  it("treats a single open-ended version as current forever", () => {
    const versions = groupIntoVersions(
      [rule("2020-01-01", 1, "09:00", "17:00")],
      "2099-12-31",
    );

    expect(versions[0].isCurrent).toBe(true);
    expect(versions[0].effectiveTo).toBeNull();
  });

  it("has no version in force when the only one starts in the future", () => {
    const versions = groupIntoVersions(
      [rule("2026-10-01", 1, "09:00", "17:00")],
      "2026-08-21",
    );

    expect(versions.some((version) => version.isCurrent)).toBe(false);
    expect(versions[0].isFuture).toBe(true);
  });
});

describe("weeklyMinutesOf", () => {
  it("adds up a week with a lunch break", () => {
    expect(
      weeklyMinutesOf([
        {
          weekday: 1,
          intervals: [
            { startLocal: "09:00", endLocal: "13:00" },
            { startLocal: "14:00", endLocal: "18:00" },
          ],
        },
      ]),
    ).toBe(480);
  });

  /** A night shift counts its real length, not a negative number. */
  it("counts a midnight-crossing shift as its real length", () => {
    expect(
      weeklyMinutesOf([
        {
          weekday: 1,
          intervals: [{ startLocal: "22:00", endLocal: "06:00" }],
        },
      ]),
    ).toBe(480);
  });

  it("is zero for a closed week", () => {
    expect(weeklyMinutesOf([{ weekday: 1, intervals: [] }])).toBe(0);
  });
});

describe("previousDay", () => {
  it("steps back a calendar day", () => {
    expect(previousDay("2026-09-01")).toBe("2026-08-31");
  });

  it("steps back across a year boundary", () => {
    expect(previousDay("2027-01-01")).toBe("2026-12-31");
  });

  it("steps back into a leap day", () => {
    expect(previousDay("2028-03-01")).toBe("2028-02-29");
  });

  /**
   * Calendar arithmetic, not a fixed 86 400 000 ms subtraction. On the day
   * after a spring-forward the previous local day is only 23 hours back, and
   * a millisecond version of this would return the same date it was given.
   */
  it("steps back across a DST boundary", () => {
    expect(previousDay("2026-03-30")).toBe("2026-03-29");
    expect(previousDay("2026-10-26")).toBe("2026-10-25");
  });
});
