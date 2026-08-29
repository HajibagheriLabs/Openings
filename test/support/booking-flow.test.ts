import { describe, expect, it } from "vitest";

import { buildBookingFlow } from "@/lib/booking/flow";

/**
 * The shape of the flow.
 *
 * The progress line is a promise about how much is left, so the two failures
 * that matter are showing a step that asks nothing (one service, one stylist)
 * and counting a step that will never be rendered.
 */

const nothingChosen = {
  service: false,
  staff: false,
  date: false,
  time: false,
};

describe("buildBookingFlow", () => {
  it("is two steps for one service and one person", () => {
    const flow = buildBookingFlow({
      serviceCount: 1,
      staffCount: 1,
      hasDeposit: false,
      chosen: nothingChosen,
    });

    expect(flow.steps).toEqual(["date", "time", "details"]);
    expect(flow.current).toBe("date");
    expect(flow.step).toBe(1);
    expect(flow.total).toBe(3);
  });

  it("is four steps when both choices exist", () => {
    const flow = buildBookingFlow({
      serviceCount: 3,
      staffCount: 2,
      hasDeposit: false,
      chosen: nothingChosen,
    });

    expect(flow.steps).toEqual([
      "service",
      "staff",
      "date",
      "time",
      "details",
    ]);
    expect(flow.current).toBe("service");
    expect(flow.total).toBe(5);
  });

  it("skips the staff step when only one person qualifies", () => {
    const flow = buildBookingFlow({
      serviceCount: 3,
      staffCount: 1,
      hasDeposit: false,
      chosen: { service: true, staff: false, date: false, time: false },
    });

    expect(flow.steps).toEqual(["service", "date", "time", "details"]);
    // Nothing is waiting on a staff answer, so the day is next.
    expect(flow.current).toBe("date");
    expect(flow.step).toBe(2);
  });

  it("advances to the first unanswered step", () => {
    const flow = buildBookingFlow({
      serviceCount: 3,
      staffCount: 2,
      hasDeposit: false,
      chosen: { service: true, staff: false, date: false, time: false },
    });

    expect(flow.current).toBe("staff");
    expect(flow.step).toBe(2);
  });

  it("lands on the details step once a time is held", () => {
    const flow = buildBookingFlow({
      serviceCount: 3,
      staffCount: 2,
      hasDeposit: false,
      chosen: { service: true, staff: true, date: true, time: true },
    });

    expect(flow.current).toBe("details");
    expect(flow.step).toBe(5);
    expect(flow.total).toBe(5);
  });

  it("adds a payment step only when a deposit is due", () => {
    const free = buildBookingFlow({
      serviceCount: 1,
      staffCount: 1,
      hasDeposit: false,
      chosen: nothingChosen,
    });

    const paid = buildBookingFlow({
      serviceCount: 1,
      staffCount: 1,
      hasDeposit: true,
      chosen: nothingChosen,
    });

    /* A FREE CONSULTATION HAS NO PAYMENT STEP. Counting one and then finishing
       early is a small lie that makes every other number on the page suspect. */
    expect(free.steps).toEqual(["date", "time", "details"]);
    expect(paid.steps).toEqual(["date", "time", "details", "pay"]);
  });

  it("never reports a step outside the flow", () => {
    const flow = buildBookingFlow({
      serviceCount: 1,
      staffCount: 1,
      hasDeposit: false,
      chosen: { service: true, staff: true, date: true, time: true },
    });

    expect(flow.step).toBeLessThanOrEqual(flow.total);
    expect(flow.steps[flow.step - 1]).toBe(flow.current);
  });
});
