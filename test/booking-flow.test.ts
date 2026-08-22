import { describe, expect, it } from "vitest";

import { buildBookingFlow } from "@/lib/booking/flow";

/**
 * The shape of the flow.
 *
 * The progress line is a promise about how much is left, so the two failures
 * that matter are showing a step that asks nothing (one service, one stylist)
 * and counting a step that will never be rendered.
 */

const nothingChosen = { service: false, staff: false, date: false };

describe("buildBookingFlow", () => {
  it("is two steps for one service and one person", () => {
    const flow = buildBookingFlow({
      serviceCount: 1,
      staffCount: 1,
      chosen: nothingChosen,
    });

    expect(flow.steps).toEqual(["date", "time"]);
    expect(flow.current).toBe("date");
    expect(flow.step).toBe(1);
    expect(flow.total).toBe(2);
  });

  it("is four steps when both choices exist", () => {
    const flow = buildBookingFlow({
      serviceCount: 3,
      staffCount: 2,
      chosen: nothingChosen,
    });

    expect(flow.steps).toEqual(["service", "staff", "date", "time"]);
    expect(flow.current).toBe("service");
    expect(flow.total).toBe(4);
  });

  it("skips the staff step when only one person qualifies", () => {
    const flow = buildBookingFlow({
      serviceCount: 3,
      staffCount: 1,
      chosen: { service: true, staff: false, date: false },
    });

    expect(flow.steps).toEqual(["service", "date", "time"]);
    // Nothing is waiting on a staff answer, so the day is next.
    expect(flow.current).toBe("date");
    expect(flow.step).toBe(2);
  });

  it("advances to the first unanswered step", () => {
    const flow = buildBookingFlow({
      serviceCount: 3,
      staffCount: 2,
      chosen: { service: true, staff: false, date: false },
    });

    expect(flow.current).toBe("staff");
    expect(flow.step).toBe(2);
  });

  it("lands on the time step when a shared link carries every answer", () => {
    const flow = buildBookingFlow({
      serviceCount: 3,
      staffCount: 2,
      chosen: { service: true, staff: true, date: true },
    });

    expect(flow.current).toBe("time");
    expect(flow.step).toBe(4);
    expect(flow.total).toBe(4);
  });

  it("never reports a step outside the flow", () => {
    const flow = buildBookingFlow({
      serviceCount: 1,
      staffCount: 1,
      chosen: { service: true, staff: true, date: true },
    });

    expect(flow.step).toBeLessThanOrEqual(flow.total);
    expect(flow.steps[flow.step - 1]).toBe(flow.current);
  });
});
