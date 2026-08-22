import { describe, expect, it } from "vitest";

import {
  ANY_STAFF,
  bookingUrl,
  parseBookingQuery,
} from "@/lib/booking/url";

/**
 * The URL contract.
 *
 * The booking page keeps every choice in the query string, which means the
 * query string is a public API: a link somebody pasted into a message six
 * weeks ago will come back through this parser, and so will anything a bored
 * person types by hand. Nothing here may throw, and nothing unusable may be
 * mistaken for an answer.
 */

const SERVICE = "6b5cf0d0-1c9e-4a1a-9e5a-2f0b8f2f9a11";
const STAFF = "0f2a3c44-9b1d-4f77-8f5f-1c2a4e6b8d90";

describe("parseBookingQuery", () => {
  it("reads a complete state", () => {
    expect(
      parseBookingQuery({
        service: SERVICE,
        staff: STAFF,
        date: "2026-09-03",
        month: "2026-09",
        step: "details",
      }),
    ).toEqual({
      service: SERVICE,
      staff: STAFF,
      date: "2026-09-03",
      month: "2026-09",
      step: "details",
    });
  });

  it("treats 'any' as a real staff answer", () => {
    expect(parseBookingQuery({ staff: ANY_STAFF }).staff).toBe(ANY_STAFF);
  });

  it("reports nothing chosen for an empty query", () => {
    expect(parseBookingQuery({})).toEqual({
      service: null,
      staff: null,
      date: null,
      month: null,
      step: null,
    });
  });

  it("drops values that are not the right shape instead of throwing", () => {
    const query = parseBookingQuery({
      service: "not-a-uuid",
      staff: "42",
      date: "03/09/2026",
      month: "September",
      step: "pay-now",
    });

    expect(query).toEqual({
      service: null,
      staff: null,
      date: null,
      month: null,
      step: null,
    });
  });

  it("rejects a date that looks right but cannot exist", () => {
    expect(parseBookingQuery({ date: "2026-13-01" }).date).toBeNull();
    expect(parseBookingQuery({ date: "2026-09-32" }).date).toBeNull();
    expect(parseBookingQuery({ month: "2026-00" }).month).toBeNull();
  });

  it("only honours the two steps that exist", () => {
    /* `details` and `booked` are the screens that cannot be inferred from what
       has been answered — see the note on BOOKING_STEP_PARAM. Anything else in
       that slot is somebody guessing, and is dropped. */
    expect(parseBookingQuery({ step: "details" }).step).toBe("details");
    expect(parseBookingQuery({ step: "booked" }).step).toBe("booked");
    expect(parseBookingQuery({ step: "pay" }).step).toBeNull();
  });

  it("takes the first value when a parameter is repeated", () => {
    expect(parseBookingQuery({ date: ["2026-09-03", "2026-09-04"] }).date).toBe(
      "2026-09-03",
    );
  });
});

describe("bookingUrl", () => {
  it("is a bare path when nothing is chosen", () => {
    expect(bookingUrl("rosas-hair-studio")).toBe("/book/rosas-hair-studio");
  });

  it("omits empty parameters rather than writing them out", () => {
    expect(
      bookingUrl("rosas-hair-studio", {
        service: SERVICE,
        staff: null,
        date: undefined,
      }),
    ).toBe(`/book/rosas-hair-studio?service=${SERVICE}`);
  });

  it("writes the state it is given, in step order", () => {
    expect(
      bookingUrl("rosas-hair-studio", {
        service: SERVICE,
        staff: ANY_STAFF,
        date: "2026-09-03",
        month: "2026-09",
      }),
    ).toBe(
      `/book/rosas-hair-studio?service=${SERVICE}&staff=any&date=2026-09-03&month=2026-09`,
    );
  });

  it("round-trips through the parser", () => {
    const url = bookingUrl("rosas-hair-studio", {
      service: SERVICE,
      staff: STAFF,
      date: "2026-09-03",
    });

    const params = new URL(url, "https://example.test").searchParams;

    expect(parseBookingQuery(Object.fromEntries(params))).toEqual({
      service: SERVICE,
      staff: STAFF,
      date: "2026-09-03",
      month: null,
      step: null,
    });
  });
});
