import { describe, expect, it } from "vitest";

import {
  serviceBookability,
  unbookableSummary,
} from "@/lib/scheduling/bookability";
import {
  blockedMinutes,
  blockedTimeParts,
  blockedTimeSentence,
} from "@/lib/scheduling/blocked-time";

/**
 * These two modules decide what a customer is offered and what the calendar
 * loses, and both of them are pure arithmetic over three or four numbers —
 * which is exactly the kind of code that gets quietly broken by an unrelated
 * refactor and only shows up as a service that stopped appearing.
 */

const GRANULARITY = 15;

describe("serviceBookability", () => {
  it("accepts an active service on the grid with an active performer", () => {
    const result = serviceBookability(
      { isActive: true, durationMin: 45, activeStaffCount: 1 },
      GRANULARITY,
    );

    expect(result).toEqual({ bookable: true, reasons: [] });
  });

  it("refuses a service nobody is assigned to", () => {
    const result = serviceBookability(
      { isActive: true, durationMin: 45, activeStaffCount: 0 },
      GRANULARITY,
    );

    expect(result.bookable).toBe(false);
    expect(result.reasons).toContain("no-active-staff");
  });

  /**
   * The case the admin flag exists for: the links are all there, but every
   * person on the other end of them is switched off. Counting links instead of
   * ACTIVE links is the bug this pins down.
   */
  it("treats a service whose staff are all deactivated as unbookable", () => {
    const result = serviceBookability(
      { isActive: true, durationMin: 60, activeStaffCount: 0 },
      GRANULARITY,
    );

    expect(result.reasons).toEqual(["no-active-staff"]);
  });

  it("refuses a duration that is not a whole number of booking intervals", () => {
    const result = serviceBookability(
      { isActive: true, durationMin: 50, activeStaffCount: 2 },
      GRANULARITY,
    );

    expect(result.bookable).toBe(false);
    expect(result.reasons).toEqual(["off-grid"]);
  });

  it("accepts the same duration on a grid it does divide", () => {
    expect(
      serviceBookability(
        { isActive: true, durationMin: 50, activeStaffCount: 1 },
        10,
      ).bookable,
    ).toBe(true);
  });

  it("reports every reason at once, not just the first", () => {
    const result = serviceBookability(
      { isActive: false, durationMin: 50, activeStaffCount: 0 },
      GRANULARITY,
    );

    expect(result.reasons).toEqual(["inactive", "no-active-staff", "off-grid"]);
    expect(unbookableSummary(result.reasons)).toContain("Nobody can perform it");
  });

  it("has nothing to summarise when the service is bookable", () => {
    expect(unbookableSummary([])).toBeNull();
  });

  /** Defensive: a zero granularity must not divide by zero into NaN. */
  it("does not flag an off-grid duration when granularity is unusable", () => {
    const result = serviceBookability(
      { isActive: true, durationMin: 45, activeStaffCount: 1 },
      0,
    );

    expect(result.reasons).not.toContain("off-grid");
  });
});

describe("blocked time", () => {
  it("adds both buffers to the customer-facing duration", () => {
    expect(
      blockedMinutes({
        durationMin: 45,
        bufferBeforeMin: 10,
        bufferAfterMin: 10,
      }),
    ).toBe(65);
  });

  /** The sentence the service form shows, verbatim from the brief. */
  it("writes the sum the way the form states it", () => {
    expect(
      blockedTimeSentence({
        durationMin: 45,
        bufferBeforeMin: 0,
        bufferAfterMin: 10,
      }),
    ).toBe("45 min appointment + 10 min cleanup = 55 min of the day");
  });

  it("says the plain thing when there is no sum to show", () => {
    expect(
      blockedTimeSentence({
        durationMin: 45,
        bufferBeforeMin: 0,
        bufferAfterMin: 0,
      }),
    ).toBe("45 min appointment, and nothing reserved around it.");
  });

  it("omits zero-length buffers from the strip", () => {
    const parts = blockedTimeParts({
      durationMin: 30,
      bufferBeforeMin: 0,
      bufferAfterMin: 5,
    });

    expect(parts.map((part) => part.kind)).toEqual(["service", "after"]);
  });

  it("draws the parts in the order they happen", () => {
    const parts = blockedTimeParts({
      durationMin: 30,
      bufferBeforeMin: 5,
      bufferAfterMin: 15,
    });

    expect(parts.map((part) => part.kind)).toEqual([
      "before",
      "service",
      "after",
    ]);
    expect(parts.map((part) => part.minutes)).toEqual([5, 30, 15]);
  });
});
