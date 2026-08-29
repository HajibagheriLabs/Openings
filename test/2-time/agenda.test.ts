import { describe, expect, it } from "vitest";

import { GAP_THRESHOLD_MIN } from "@/lib/admin/calendar";
import {
  buildAgendaDay,
  buildAgendaWeek,
  occupiesTime,
  segmentLabel,
  summariseDay,
  windowFor,
  type AgendaAppointment,
  type AgendaClosure,
  type AgendaStaff,
} from "@/lib/scheduling/agenda";
import type { Span } from "@/lib/scheduling/availability";
import { resolveWallClock } from "@/lib/scheduling/wall-clock";

/**
 * The master schedule, shaped.
 *
 * Every test here runs against the PURE half — rows in, ribbon columns out,
 * with the clock injected. That is the whole reason the shaping is separate
 * from the loading: "a booking is carved out of open time", "a cancelled
 * appointment does not block", "a gap that has already passed is not a gap"
 * are product rules, and they should be pinned by fast unit tests rather than
 * by opening a browser at nine in the morning.
 *
 * The fixtures use Europe/Berlin, and two of them sit deliberately on the two
 * days a local day is not 24 hours long.
 */

const TZ = "Europe/Berlin";

/** A plain Tuesday in September. Berlin is UTC+2 (CEST) that day. */
const DATE = "2026-09-15";

/** `[startOfDay, startOfNextDay)` for that Tuesday, in Berlin. */
const DAY: Span = {
  start: Date.UTC(2026, 8, 14, 22, 0),
  end: Date.UTC(2026, 8, 15, 22, 0),
};

const ANNA: AgendaStaff = { id: "anna", name: "Anna Bakke", initials: "AB" };
const RAJ: AgendaStaff = { id: "raj", name: "Raj Mehta", initials: "RM" };

/** Local Berlin wall clock on the fixture Tuesday, as an ISO instant. */
function at(hour: number, minute = 0): string {
  return new Date(Date.UTC(2026, 8, 15, hour - 2, minute)).toISOString();
}

/** A shift, in real instants, from the local hours it is described by. */
function shift(fromHour: number, toHour: number): Span {
  return { start: Date.parse(at(fromHour)), end: Date.parse(at(toHour)) };
}

function appointment(
  overrides: Partial<AgendaAppointment> & {
    startsAt: string;
    endsAt: string;
  },
): AgendaAppointment {
  return {
    id: overrides.id ?? `appointment-${overrides.startsAt}`,
    staffId: overrides.staffId ?? ANNA.id,
    status: overrides.status ?? "confirmed",
    slotStartsAt: overrides.slotStartsAt ?? overrides.startsAt,
    slotEndsAt: overrides.slotEndsAt ?? overrides.endsAt,
    serviceName: overrides.serviceName ?? "Cut and finish",
    customerName: overrides.customerName ?? "Sam Okafor",
    customerInitials: overrides.customerInitials ?? "SO",
    priceCents: overrides.priceCents ?? 4_500,
    depositCents: overrides.depositCents ?? 1_000,
    isLiveHold: overrides.isLiveHold ?? false,
    ...overrides,
  };
}

const NINE_AM = new Date(at(9));

describe("occupiesTime", () => {
  it("counts confirmed, completed and no-show appointments", () => {
    for (const status of ["confirmed", "completed", "no_show"] as const) {
      expect(occupiesTime({ status, isLiveHold: false })).toBe(true);
    }
  });

  it("counts a live hold and ignores a lapsed one", () => {
    expect(occupiesTime({ status: "held", isLiveHold: true })).toBe(true);
    expect(occupiesTime({ status: "held", isLiveHold: false })).toBe(false);
  });

  it("ignores a cancelled appointment, because the slot is genuinely free", () => {
    /* The exclusion constraint does not cover `cancelled`, so something else
       can be booked into that time. Drawing it would put a block over time the
       owner is free to sell. */
    expect(occupiesTime({ status: "cancelled", isLiveHold: false })).toBe(false);
  });
});

describe("buildAgendaDay", () => {
  const base = {
    date: DATE,
    timeZone: TZ,
    dayWindow: DAY,
    now: NINE_AM,
  };

  it("carves a booking out of the open time rather than stacking on it", () => {
    const day = buildAgendaDay({
      ...base,
      staff: [ANNA],
      openByStaff: new Map([[ANNA.id, [shift(9, 17)]]]),
      appointments: [
        appointment({ startsAt: at(11), endsAt: at(12) }),
      ],
      closures: [],
    });

    const [column] = day.columns;
    const open = column.segments.filter((s) => s.state === "open");
    const booked = column.segments.filter((s) => s.state === "booked");

    expect(booked).toHaveLength(1);
    // 09:00–11:00 and 12:00–17:00. The hour in between belongs to the booking.
    expect(open.map((s) => [s.startMinute, s.durationMin])).toEqual([
      [9 * 60, 120],
      [12 * 60, 300],
    ]);
  });

  it("subtracts the BLOCKING range, buffers included, not the visible one", () => {
    const day = buildAgendaDay({
      ...base,
      staff: [ANNA],
      openByStaff: new Map([[ANNA.id, [shift(9, 17)]]]),
      appointments: [
        appointment({
          startsAt: at(11),
          endsAt: at(12),
          /* Fifteen minutes of cleanup after. It is working time, and drawing
             it as open would offer a slot the database will refuse. */
          slotStartsAt: at(11),
          slotEndsAt: at(12, 15),
        }),
      ],
      closures: [],
    });

    const open = day.columns[0].segments.filter((s) => s.state === "open");

    expect(open[1].startMinute).toBe(12 * 60 + 15);
  });

  it("draws the booking itself on the customer-facing span", () => {
    const day = buildAgendaDay({
      ...base,
      staff: [ANNA],
      openByStaff: new Map([[ANNA.id, [shift(9, 17)]]]),
      appointments: [
        appointment({
          startsAt: at(11),
          endsAt: at(12),
          slotStartsAt: at(10, 45),
          slotEndsAt: at(12, 15),
        }),
      ],
      closures: [],
    });

    const booked = day.columns[0].segments.find((s) => s.state === "booked");

    /* The owner is looking at when somebody is in the chair, not at when the
       database stops accepting neighbours. */
    expect(booked?.startMinute).toBe(11 * 60);
    expect(booked?.durationMin).toBe(60);
  });

  it("labels a booking with the customer's initials and the service", () => {
    expect(
      segmentLabel(
        appointment({
          startsAt: at(11),
          endsAt: at(12),
          customerInitials: "SO",
          serviceName: "Colour",
        }),
      ),
    ).toBe("SO · Colour");
  });

  it("gives every active staff member a column, in the order supplied", () => {
    const day = buildAgendaDay({
      ...base,
      staff: [ANNA, RAJ],
      openByStaff: new Map([
        [ANNA.id, [shift(9, 17)]],
        [RAJ.id, [shift(12, 20)]],
      ]),
      appointments: [],
      closures: [],
    });

    expect(day.columns.map((column) => column.id)).toEqual([ANNA.id, RAJ.id]);
    expect(day.columns[1].segments[0].startMinute).toBe(12 * 60);
  });

  it("puts a business-wide closure in every lane and a personal one in its own", () => {
    const closures: AgendaClosure[] = [
      {
        id: "everyone",
        staffId: null,
        startsAt: at(13),
        endsAt: at(14),
        reason: "Stocktake",
      },
      {
        id: "raj-only",
        staffId: RAJ.id,
        startsAt: at(15),
        endsAt: at(16),
        reason: "Dentist",
      },
    ];

    const day = buildAgendaDay({
      ...base,
      staff: [ANNA, RAJ],
      openByStaff: new Map([
        [ANNA.id, [shift(9, 17)]],
        [RAJ.id, [shift(9, 17)]],
      ]),
      appointments: [],
      closures,
    });

    const blockedIn = (index: number) =>
      day.columns[index].segments
        .filter((s) => s.state === "blocked")
        .map((s) => s.label);

    expect(blockedIn(0)).toEqual(["Stocktake"]);
    expect(blockedIn(1)).toEqual(["Stocktake", "Dentist"]);
  });

  it("does not draw a cancelled appointment, and leaves its time open", () => {
    const day = buildAgendaDay({
      ...base,
      staff: [ANNA],
      openByStaff: new Map([[ANNA.id, [shift(9, 17)]]]),
      appointments: [
        appointment({
          startsAt: at(11),
          endsAt: at(12),
          status: "cancelled",
        }),
      ],
      closures: [],
    });

    const segments = day.columns[0].segments;

    expect(segments.some((s) => s.state === "booked")).toBe(false);
    // One unbroken stretch of open time: nothing was taken out of it.
    expect(segments.filter((s) => s.state === "open")).toHaveLength(1);
  });

  it("treats a lapsed hold as free and a live one as taken", () => {
    const build = (isLiveHold: boolean) =>
      buildAgendaDay({
        ...base,
        staff: [ANNA],
        openByStaff: new Map([[ANNA.id, [shift(9, 17)]]]),
        appointments: [
          appointment({
            startsAt: at(11),
            endsAt: at(12),
            status: "held",
            isLiveHold,
          }),
        ],
        closures: [],
      });

    expect(
      build(true).columns[0].segments.some((s) => s.state === "held"),
    ).toBe(true);
    expect(
      build(false).columns[0].segments.some((s) => s.state === "held"),
    ).toBe(false);
  });

  it("marks what is over as past, against the injected clock", () => {
    const day = buildAgendaDay({
      ...base,
      now: new Date(at(13)),
      staff: [ANNA],
      openByStaff: new Map([[ANNA.id, [shift(9, 17)]]]),
      appointments: [
        appointment({ id: "morning", startsAt: at(10), endsAt: at(11) }),
        appointment({ id: "afternoon", startsAt: at(15), endsAt: at(16) }),
      ],
      closures: [],
    });

    const byId = new Map(day.columns[0].segments.map((s) => [s.id, s]));

    expect(byId.get("morning")?.isPast).toBe(true);
    expect(byId.get("afternoon")?.isPast).toBe(false);
    /* Past or not, it stays pressable: "mark as a no-show" is a decision taken
       after the appointment did not happen. */
    expect(byId.get("morning")?.selectable).toBe(true);
  });

  it("draws the now line only on the day that is actually happening", () => {
    const today = buildAgendaDay({
      ...base,
      now: new Date(at(11, 30)),
      staff: [ANNA],
      openByStaff: new Map([[ANNA.id, [shift(9, 17)]]]),
      appointments: [],
      closures: [],
    });

    const otherDay = buildAgendaDay({
      ...base,
      now: new Date(Date.UTC(2026, 8, 20, 9, 0)),
      staff: [ANNA],
      openByStaff: new Map([[ANNA.id, [shift(9, 17)]]]),
      appointments: [],
      closures: [],
    });

    expect(today.nowMinute).toBe(11 * 60 + 30);
    expect(otherDay.nowMinute).toBeNull();
  });

  it("clips a shift that started the night before to this day's midnight", () => {
    const overnight: Span = {
      // 22:00 Monday to 04:00 Tuesday, local.
      start: Date.UTC(2026, 8, 14, 20, 0),
      end: Date.UTC(2026, 8, 15, 2, 0),
    };

    const day = buildAgendaDay({
      ...base,
      staff: [ANNA],
      openByStaff: new Map([[ANNA.id, [overnight]]]),
      appointments: [],
      closures: [],
    });

    const [open] = day.columns[0].segments;

    // Only the Tuesday tail: 00:00 to 04:00.
    expect(open.startMinute).toBe(0);
    expect(open.durationMin).toBe(4 * 60);
  });
});

describe("windowFor", () => {
  it("falls back to a working day when there is nothing to draw", () => {
    expect(windowFor([])).toEqual({ startMinute: 8 * 60, endMinute: 20 * 60 });
  });

  it("snaps out to whole hours so the ruler starts on the clock", () => {
    const window = windowFor([
      {
        id: "a",
        label: "A",
        segments: [
          { id: "s", state: "booked", startMinute: 9 * 60 + 20, durationMin: 50 },
        ],
      },
    ]);

    expect(window.startMinute).toBe(9 * 60);
    // Content ends at 10:10, snapped to 11:00, then widened to the six-hour
    // minimum — a two-hour strip is not a day.
    expect(window.endMinute).toBe(15 * 60);
  });
});

describe("buildAgendaWeek", () => {
  /** Monday to Sunday of the fixture week, and their instant windows. */
  const dates = [
    "2026-09-14",
    "2026-09-15",
    "2026-09-16",
    "2026-09-17",
    "2026-09-18",
    "2026-09-19",
    "2026-09-20",
  ];

  const dayWindows: Span[] = dates.map((_, index) => ({
    start: Date.UTC(2026, 8, 13 + index, 22, 0),
    end: Date.UTC(2026, 8, 14 + index, 22, 0),
  }));

  const base = {
    dates,
    timeZone: TZ,
    dayWindows,
    now: NINE_AM,
    closures: [],
  };

  it("gives one column per day, Monday first", () => {
    const week = buildAgendaWeek({
      ...base,
      staff: [ANNA],
      openByStaff: new Map([[ANNA.id, [shift(9, 17)]]]),
      appointments: [],
      singleStaff: true,
    });

    expect(week.columns).toHaveLength(7);
    expect(week.columns.map((column) => column.id)).toEqual(dates);
    expect(week.columns[0].label).toBe("Mon");
  });

  it("merges overlapping staff into counted bands when nobody is filtered", () => {
    /* Two people working at eleven is ordinary. Drawing them individually
       would stack two segments on the same pixels and show one. */
    const week = buildAgendaWeek({
      ...base,
      staff: [ANNA, RAJ],
      openByStaff: new Map([
        [ANNA.id, [shift(9, 17)]],
        [RAJ.id, [shift(9, 17)]],
      ]),
      appointments: [
        appointment({ id: "a", staffId: ANNA.id, startsAt: at(11), endsAt: at(12) }),
        appointment({ id: "b", staffId: RAJ.id, startsAt: at(11), endsAt: at(12) }),
      ],
      singleStaff: false,
    });

    const tuesday = week.columns[1];
    const booked = tuesday.segments.filter((s) => s.state === "booked");

    expect(booked).toHaveLength(1);
    expect(booked[0].label).toBe("2 booked");
  });

  it("draws appointments individually when one person is being looked at", () => {
    const week = buildAgendaWeek({
      ...base,
      staff: [ANNA],
      openByStaff: new Map([[ANNA.id, [shift(9, 17)]]]),
      appointments: [
        appointment({ id: "a", startsAt: at(11), endsAt: at(12) }),
        appointment({ id: "b", startsAt: at(14), endsAt: at(15) }),
      ],
      singleStaff: true,
    });

    const booked = week.columns[1].segments.filter((s) => s.state === "booked");

    expect(booked.map((s) => s.label)).toEqual([
      "SO · Cut and finish",
      "SO · Cut and finish",
    ]);
  });

  it("finds today among the seven days, and nothing when it is elsewhere", () => {
    expect(
      buildAgendaWeek({
        ...base,
        staff: [ANNA],
        openByStaff: new Map(),
        appointments: [],
        singleStaff: true,
      }).todayIndex,
    ).toBe(1);

    expect(
      buildAgendaWeek({
        ...base,
        now: new Date(Date.UTC(2026, 9, 20, 9, 0)),
        staff: [ANNA],
        openByStaff: new Map(),
        appointments: [],
        singleStaff: true,
      }).todayIndex,
    ).toBe(-1);
  });
});

describe("summariseDay", () => {
  const base = {
    staff: [ANNA],
    openByStaff: new Map([[ANNA.id, [shift(9, 17)]]]),
    closures: [] as AgendaClosure[],
    dayWindow: DAY,
  };

  it("counts what is coming and what it is worth", () => {
    const summary = summariseDay({
      ...base,
      now: NINE_AM,
      appointments: [
        appointment({ id: "a", startsAt: at(10), endsAt: at(11), priceCents: 4_500 }),
        appointment({
          id: "b",
          startsAt: at(12),
          endsAt: at(13),
          priceCents: 6_000,
          status: "completed",
        }),
        /* A no-show earned nothing, however much the price column says. */
        appointment({
          id: "c",
          startsAt: at(14),
          endsAt: at(15),
          priceCents: 9_000,
          status: "no_show",
        }),
      ],
    });

    expect(summary.bookedCount).toBe(3);
    expect(summary.expectedRevenueCents).toBe(10_500);
    expect(summary.depositsTakenCents).toBe(2_000);
  });

  it("counts live holds separately from bookings", () => {
    const summary = summariseDay({
      ...base,
      now: NINE_AM,
      appointments: [
        appointment({ id: "a", startsAt: at(10), endsAt: at(11) }),
        appointment({
          id: "b",
          startsAt: at(12),
          endsAt: at(13),
          status: "held",
          isLiveHold: true,
        }),
      ],
    });

    expect(summary.bookedCount).toBe(1);
    expect(summary.heldCount).toBe(1);
  });

  it("names the next appointment that has not started", () => {
    const summary = summariseDay({
      ...base,
      now: new Date(at(11, 30)),
      appointments: [
        appointment({ id: "morning", startsAt: at(10), endsAt: at(11) }),
        appointment({ id: "next", startsAt: at(13), endsAt: at(14) }),
        appointment({ id: "later", startsAt: at(15), endsAt: at(16) }),
      ],
    });

    expect(summary.next?.id).toBe("next");
  });

  it("reports gaps over the threshold and ignores shorter ones", () => {
    const summary = summariseDay({
      ...base,
      now: NINE_AM,
      appointments: [
        appointment({ id: "a", startsAt: at(9), endsAt: at(11) }),
        /* 20 minutes free here — below the threshold, not worth naming. */
        appointment({ id: "b", startsAt: at(11, 20), endsAt: at(13) }),
        /* Two hours free here. */
        appointment({ id: "c", startsAt: at(15), endsAt: at(17) }),
      ],
    });

    expect(summary.gaps).toHaveLength(1);
    expect(summary.gaps[0].minutes).toBe(120);
    expect(summary.gaps[0].minutes).toBeGreaterThanOrEqual(GAP_THRESHOLD_MIN);
  });

  it("does not report a gap that has already passed", () => {
    /* Half of the morning is gone. What is left of it cannot be sold, and an
       owner scanning for "what could I still fill" does not want it listed. */
    const summary = summariseDay({
      ...base,
      now: new Date(at(14)),
      appointments: [
        appointment({ id: "a", startsAt: at(9), endsAt: at(10) }),
        appointment({ id: "b", startsAt: at(13), endsAt: at(14) }),
      ],
    });

    expect(summary.gaps).toHaveLength(1);
    expect(summary.gaps[0].startsAt).toBe(at(14));
    expect(summary.gaps[0].endsAt).toBe(at(17));
  });

  it("does not count time off as a gap worth filling", () => {
    const summary = summariseDay({
      ...base,
      now: NINE_AM,
      closures: [
        {
          id: "lunch",
          staffId: null,
          startsAt: at(12),
          endsAt: at(13),
          reason: "Lunch",
        },
      ],
      appointments: [
        appointment({ id: "a", startsAt: at(9), endsAt: at(12) }),
        appointment({ id: "b", startsAt: at(13), endsAt: at(17) }),
      ],
    });

    expect(summary.gaps).toEqual([]);
  });
});

/* ===========================================================================
   The two awkward days
   =========================================================================== */

describe("resolveWallClock", () => {
  it("resolves an ordinary local time to the right instant", () => {
    const resolved = resolveWallClock("2026-09-15", "14:30", TZ);

    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.instant.toISOString()).toBe(
      "2026-09-15T12:30:00.000Z",
    );
    expect(resolved.ok && resolved.ambiguous).toBe(false);
  });

  it("REFUSES a local time that does not exist on a spring-forward day", () => {
    /* 29 March 2026: Berlin jumps 02:00 → 03:00. There is no instant that
       02:30 names, and "compatible" would quietly book them at 03:30. */
    const resolved = resolveWallClock("2026-03-29", "02:30", TZ);

    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.reason).toBe("nonexistent");
    expect(!resolved.ok && resolved.message).toContain("clocks go forward");
  });

  it("accepts the earlier of two on a fall-back day, and says it was ambiguous", () => {
    /* 25 October 2026: Berlin repeats 02:00–03:00. The time is not impossible,
       only ambiguous, and refusing a time that exists would be pedantry. */
    const resolved = resolveWallClock("2026-10-25", "02:30", TZ);

    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.ambiguous).toBe(true);
    // CEST (+02:00) — the first of the two 02:30s.
    expect(resolved.ok && resolved.instant.toISOString()).toBe(
      "2026-10-25T00:30:00.000Z",
    );
  });

  it("still resolves the hours either side of a transition", () => {
    for (const time of ["01:30", "04:00"]) {
      expect(resolveWallClock("2026-03-29", time, TZ).ok).toBe(true);
    }
  });

  it("refuses something that is not a date and a time", () => {
    const resolved = resolveWallClock("not-a-date", "14:30", TZ);

    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.reason).toBe("invalid");
  });
});
