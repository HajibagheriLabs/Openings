import { describe, expect, it } from "vitest";

import {
  computeAvailability,
  expandRules,
  spanMinutes,
  subtractSpans,
  type AvailabilityContext,
  type BlockedRow,
  type RuleRow,
  type TimeOffRow,
} from "@/lib/scheduling/availability";

/* ===========================================================================
   THE AVAILABILITY SUITE
   ---------------------------------------------------------------------------
   Every test here is deterministic. The clock is injected, never read; the
   dates are fixed; nothing touches a database. Run it in January in Auckland
   on a machine set to UTC-11 and it gives the same answers.

   ASSERTIONS ARE ON INSTANTS, NEVER ON FORMATTED STRINGS. A formatted string
   tests the formatter and the machine's locale; an ISO instant tests the
   thing this module is for. Where a local wall-clock time is mentioned it is
   in a comment, to say what the instant MEANS.
   =========================================================================== */

const BERLIN = "Europe/Berlin";
const NEW_YORK = "America/New_York";

/** Staff ids that read as themselves in a failure message. */
const ANA = "staff-ana";
const BO = "staff-bo";

const TEAM = [
  { id: ANA, name: "Ana Ruiz", initials: "AR" },
  { id: BO, name: "Bo Chen", initials: "BC" },
];

/**
 * A rule, written the way the hours editor writes one.
 *
 * Open-ended by default: `effective_from` far in the past and no `effective_to`
 * means "these are the hours", which is what a business that has never changed
 * them has.
 */
function rule(
  staffId: string,
  weekday: number,
  startLocal: string,
  endLocal: string,
  effective: { from?: string; to?: string | null } = {},
): RuleRow {
  return {
    staffId,
    weekday,
    startLocal: `${startLocal}:00`,
    endLocal: `${endLocal}:00`,
    effectiveFrom: effective.from ?? "2020-01-01",
    effectiveTo: effective.to ?? null,
  };
}

interface ContextOverrides {
  timeZone?: string;
  slotGranularityMin?: number;
  minLeadTimeMin?: number;
  maxAdvanceDays?: number;
  durationMin?: number;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  isActive?: boolean;
  staff?: typeof TEAM;
  rules?: RuleRow[];
  timeOff?: TimeOffRow[];
  blocked?: BlockedRow[];
}

/**
 * A business with hours and nothing in the way.
 *
 * Lead time and advance window are wide open by default so a test that is
 * about DST is not also about policy. The policy tests set them explicitly.
 */
function context(overrides: ContextOverrides = {}): AvailabilityContext {
  return {
    timeZone: overrides.timeZone ?? BERLIN,
    slotGranularityMin: overrides.slotGranularityMin ?? 15,
    minLeadTimeMin: overrides.minLeadTimeMin ?? 0,
    maxAdvanceDays: overrides.maxAdvanceDays ?? 3650,
    service: {
      id: "service-1",
      durationMin: overrides.durationMin ?? 60,
      bufferBeforeMin: overrides.bufferBeforeMin ?? 0,
      bufferAfterMin: overrides.bufferAfterMin ?? 0,
      isActive: overrides.isActive ?? true,
    },
    staff: overrides.staff ?? [TEAM[0]],
    rules: overrides.rules ?? [],
    timeOff: overrides.timeOff ?? [],
    blocked: overrides.blocked ?? [],
  };
}

/** Every opening's start instant, as ISO. */
function starts(result: { slots: { startsAt: string }[] }): string[] {
  return result.slots.map((slot) => slot.startsAt);
}

/**
 * A clock, from an unambiguous instant.
 *
 * Always written with an explicit offset so the test says exactly which moment
 * it means, rather than depending on the machine's zone.
 */
function clock(iso: string): Date {
  return new Date(iso);
}

/* ===========================================================================
   SPRING FORWARD
   ---------------------------------------------------------------------------
   Europe/Berlin, Sunday 29 March 2026: at 02:00 CET the clocks jump to 03:00
   CEST. The local day is 23 hours long and 02:00–02:59 never happens.
   =========================================================================== */

describe("spring forward", () => {
  /** 29 March 2026 is a Sunday, which is weekday 0 in the schema. */
  const SUNDAY = 0;

  /** A night shift straddling the gap: 00:00 to 08:00 local. */
  const nightRules = [rule(ANA, SUNDAY, "00:00", "08:00")];

  it("loses an hour from the day's total open minutes", () => {
    const open = expandRules(nightRules, {
      from: "2026-03-29",
      to: "2026-03-29",
      timeZone: BERLIN,
    });

    // Eight wall-clock hours, but only seven real ones: the clock skipped one.
    expect(spanMinutes(open.get(ANA)!)).toBe(420);
  });

  it("still measures a normal day as its full length", () => {
    const open = expandRules([rule(ANA, SUNDAY, "00:00", "08:00")], {
      // The Sunday before the transition — an ordinary 24-hour day.
      from: "2026-03-22",
      to: "2026-03-22",
      timeZone: BERLIN,
    });

    expect(spanMinutes(open.get(ANA)!)).toBe(480);
  });

  /**
   * THE HEADLINE. 02:00, 02:15, 02:30 and 02:45 local do not exist on this
   * day, and no opening may claim them.
   *
   * They are absent not because anything filters them out, but because the
   * slot grid advances in REAL elapsed minutes: 01:45 plus fifteen minutes is
   * 03:00 that morning.
   */
  it("never offers a wall-clock time that does not exist", () => {
    const result = computeAvailability(
      context({ rules: nightRules, durationMin: 15 }),
      {
        from: "2026-03-29",
        to: "2026-03-29",
        now: clock("2026-03-28T00:00:00Z"),
      },
    );

    // 01:45 CET is 00:45 UTC. The next opening is 03:00 CEST — 01:00 UTC.
    expect(starts(result)).toContain("2026-03-29T00:45:00.000Z");
    expect(starts(result)).toContain("2026-03-29T01:00:00.000Z");

    // Nothing between them: no 02:00, 02:15, 02:30 or 02:45 local ever
    // resolved to an instant, so no instant exists to offer.
    const gap = result.slots.filter(
      (slot) =>
        slot.startsAt > "2026-03-29T00:45:00.000Z" &&
        slot.startsAt < "2026-03-29T01:00:00.000Z",
    );

    expect(gap).toEqual([]);
  });

  it("offers one fewer hour of openings than an ordinary day", () => {
    const window = { now: clock("2026-03-01T00:00:00Z") };

    const onTransition = computeAvailability(
      context({ rules: nightRules, durationMin: 15 }),
      { from: "2026-03-29", to: "2026-03-29", ...window },
    );

    const ordinary = computeAvailability(
      context({ rules: nightRules, durationMin: 15 }),
      { from: "2026-03-22", to: "2026-03-22", ...window },
    );

    // Four 15-minute slots fewer, which is exactly the missing hour.
    expect(ordinary.slots.length - onTransition.slots.length).toBe(4);
  });

  it("keeps every opening exactly one grid step apart in real time", () => {
    const result = computeAvailability(
      context({ rules: nightRules, durationMin: 15 }),
      {
        from: "2026-03-29",
        to: "2026-03-29",
        now: clock("2026-03-01T00:00:00Z"),
      },
    );

    const gaps = result.slots
      .slice(1)
      .map(
        (slot, index) =>
          new Date(slot.startsAt).getTime() -
          new Date(result.slots[index].startsAt).getTime(),
      );

    // The grid never stutters across the transition — it is the wall clock
    // that jumps, not the elapsed time between openings.
    expect(new Set(gaps)).toEqual(new Set([15 * 60_000]));
  });
});

/* ===========================================================================
   FALL BACK
   ---------------------------------------------------------------------------
   Europe/Berlin, Sunday 25 October 2026: at 03:00 CEST the clocks go back to
   02:00 CET. The local day is 25 hours long and 02:00–02:59 happens twice.

   THE DECISION: BOTH OCCURRENCES ARE OFFERED, as two distinct openings.

   They are two different moments an hour apart, and the staff member really is
   available for both — refusing the second would throw away an hour of genuine
   capacity once a year for the convenience of the display. The API returns
   instants, so they are unambiguous by construction; it is the UI's job to
   label them (the timezone chip already shows the offset in force).
   =========================================================================== */

describe("fall back", () => {
  /** 25 October 2026 is a Sunday. */
  const SUNDAY = 0;

  const nightRules = [rule(ANA, SUNDAY, "00:00", "08:00")];

  it("gains an hour in the day's total open minutes", () => {
    const open = expandRules(nightRules, {
      from: "2026-10-25",
      to: "2026-10-25",
      timeZone: BERLIN,
    });

    // Eight wall-clock hours, nine real ones.
    expect(spanMinutes(open.get(ANA)!)).toBe(540);
  });

  it("offers both occurrences of the repeated hour, as distinct instants", () => {
    const result = computeAvailability(
      context({ rules: nightRules, durationMin: 15 }),
      {
        from: "2026-10-25",
        to: "2026-10-25",
        now: clock("2026-10-01T00:00:00Z"),
      },
    );

    // 02:30 CEST (+02:00) is 00:30 UTC; 02:30 CET (+01:00) is 01:30 UTC.
    // Two real moments, both bookable, one hour apart.
    expect(starts(result)).toContain("2026-10-25T00:30:00.000Z");
    expect(starts(result)).toContain("2026-10-25T01:30:00.000Z");
  });

  it("offers one more hour of openings than an ordinary day", () => {
    const window = { now: clock("2026-10-01T00:00:00Z") };

    const onTransition = computeAvailability(
      context({ rules: nightRules, durationMin: 15 }),
      { from: "2026-10-25", to: "2026-10-25", ...window },
    );

    const ordinary = computeAvailability(
      context({ rules: nightRules, durationMin: 15 }),
      { from: "2026-10-18", to: "2026-10-18", ...window },
    );

    expect(onTransition.slots.length - ordinary.slots.length).toBe(4);
  });

  it("returns every opening exactly once, with no duplicated instants", () => {
    const result = computeAvailability(
      context({ rules: nightRules, durationMin: 15 }),
      {
        from: "2026-10-25",
        to: "2026-10-25",
        now: clock("2026-10-01T00:00:00Z"),
      },
    );

    // The repeated wall-clock hour must not become a repeated INSTANT — that
    // would be the same moment offered twice, which is a bug rather than
    // capacity.
    expect(new Set(starts(result)).size).toBe(result.slots.length);
  });
});

/* ===========================================================================
   CROSS-TIMEZONE
   =========================================================================== */

describe("a customer in another timezone", () => {
  const MONDAY = 1;

  /**
   * THE INSTANTS DO NOT DEPEND ON WHO IS ASKING.
   *
   * A business in Berlin open 09:00–17:00 offers the same moments whether the
   * customer is in Berlin or New York. What differs is how those moments are
   * WRITTEN, and that happens in the browser with Intl.DateTimeFormat — not
   * here. This test asserts on instants precisely because that is the contract.
   */
  it("returns the business's instants regardless of the viewer", () => {
    const result = computeAvailability(
      context({ rules: [rule(ANA, MONDAY, "09:00", "17:00")] }),
      {
        from: "2026-06-15",
        to: "2026-06-15",
        now: clock("2026-06-01T00:00:00Z"),
      },
    );

    // 09:00 in Berlin in June is CEST, +02:00 — so 07:00 UTC.
    expect(result.slots[0].startsAt).toBe("2026-06-15T07:00:00.000Z");
    expect(result.timeZone).toBe(BERLIN);
  });

  it("names the business timezone, not the viewer's, in the result", () => {
    const result = computeAvailability(
      context({ rules: [rule(ANA, MONDAY, "09:00", "17:00")] }),
      {
        from: "2026-06-15",
        to: "2026-06-15",
        now: clock("2026-06-01T00:00:00Z"),
      },
    );

    expect(result.timeZone).not.toBe(NEW_YORK);
  });

  /**
   * The same instant, rendered for two people. This is the ONLY place the
   * suite formats anything, and it does so to prove the point: one moment,
   * two readings, and the difference lives entirely in the formatter.
   */
  it("is one instant that two people read differently", () => {
    const result = computeAvailability(
      context({ rules: [rule(ANA, MONDAY, "09:00", "17:00")] }),
      {
        from: "2026-06-15",
        to: "2026-06-15",
        now: clock("2026-06-01T00:00:00Z"),
      },
    );

    const instant = new Date(result.slots[0].startsAt);
    const format = (timeZone: string) =>
      new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone,
      }).format(instant);

    expect(format(BERLIN)).toBe("09:00");
    expect(format(NEW_YORK)).toBe("03:00");
  });

  /**
   * A business whose own zone has no DST, to be sure nothing here is tuned to
   * Europe. Tokyo is +09:00 all year.
   */
  it("works in a zone that has no daylight saving at all", () => {
    const result = computeAvailability(
      context({
        timeZone: "Asia/Tokyo",
        rules: [rule(ANA, MONDAY, "09:00", "17:00")],
      }),
      {
        from: "2026-06-15",
        to: "2026-06-15",
        now: clock("2026-06-01T00:00:00Z"),
      },
    );

    expect(result.slots[0].startsAt).toBe("2026-06-15T00:00:00.000Z");
  });
});

/* ===========================================================================
   MIDNIGHT-CROSSING SHIFTS
   ---------------------------------------------------------------------------
   Supported, per the decision recorded with the hours editor: `end_local <
   start_local` carries the shift into the next day.
   =========================================================================== */

describe("a shift that crosses midnight", () => {
  const MONDAY = 1;
  const TUESDAY = 2;

  /** Monday 22:00 to Tuesday 02:00. */
  const nightShift = [rule(ANA, MONDAY, "22:00", "02:00")];

  it("carries into the following day", () => {
    const result = computeAvailability(
      context({ rules: nightShift, durationMin: 60 }),
      {
        from: "2026-06-15",
        to: "2026-06-16",
        now: clock("2026-06-01T00:00:00Z"),
      },
    );

    // 22:00 CEST on Monday 15 June is 20:00 UTC; the last hour-long
    // appointment starts at 01:00 CEST on Tuesday, which is 23:00 UTC Monday.
    expect(starts(result)[0]).toBe("2026-06-15T20:00:00.000Z");
    expect(starts(result).at(-1)).toBe("2026-06-15T23:00:00.000Z");
  });

  /**
   * The tail belongs to the requested range even when the rule that produced
   * it is anchored to the day BEFORE the range starts. Expanding from one day
   * early is what makes the first day of a range as correct as the middle.
   */
  it("appears on the second day even when only that day is requested", () => {
    const result = computeAvailability(
      context({ rules: nightShift, durationMin: 60 }),
      {
        from: "2026-06-16",
        to: "2026-06-16",
        now: clock("2026-06-01T00:00:00Z"),
      },
    );

    /**
     * Only the part of the shift falling inside Tuesday: local 00:00 through
     * 01:00, on the 15-minute grid. 00:00 local on Tuesday is 22:00 UTC on
     * Monday, and 01:00 is the last hour-long start before the shift ends at
     * 02:00.
     */
    expect(starts(result)).toEqual([
      "2026-06-15T22:00:00.000Z", // 00:00 local Tuesday
      "2026-06-15T22:15:00.000Z", // 00:15
      "2026-06-15T22:30:00.000Z", // 00:30
      "2026-06-15T22:45:00.000Z", // 00:45
      "2026-06-15T23:00:00.000Z", // 01:00 — ends exactly at 02:00
    ]);

    // And nothing from Monday evening, which is outside the requested day.
    expect(
      starts(result).some((instant) => instant < "2026-06-15T22:00:00.000Z"),
    ).toBe(false);
  });

  /**
   * Two rules meeting at midnight are ONE continuous span, so a service can
   * run through the seam. If they were kept separate the window would have to
   * fit inside one of them, and the join would silently become a wall.
   */
  it("joins onto the next day's hours without a seam", () => {
    const result = computeAvailability(
      context({
        rules: [
          rule(ANA, MONDAY, "22:00", "02:00"),
          rule(ANA, TUESDAY, "02:00", "06:00"),
        ],
        durationMin: 120,
      }),
      {
        from: "2026-06-15",
        to: "2026-06-16",
        now: clock("2026-06-01T00:00:00Z"),
      },
    );

    // A two-hour appointment starting at 01:00 local runs to 03:00, straight
    // across the boundary between the two rules.
    expect(starts(result)).toContain("2026-06-15T23:00:00.000Z");
  });
});

/* ===========================================================================
   FITTING, BUFFERS AND POLICY
   =========================================================================== */

describe("a service that does not fit", () => {
  const MONDAY = 1;

  it("is not offered when it would run past closing", () => {
    const result = computeAvailability(
      context({
        rules: [rule(ANA, MONDAY, "09:00", "10:00")],
        durationMin: 60,
      }),
      {
        from: "2026-06-15",
        to: "2026-06-15",
        now: clock("2026-06-01T00:00:00Z"),
      },
    );

    // Exactly one hour of opening fits exactly one hour of service, and only
    // at the very start of it.
    expect(starts(result)).toEqual(["2026-06-15T07:00:00.000Z"]);
  });

  it("offers nothing at all when the opening is shorter than the service", () => {
    const result = computeAvailability(
      context({
        rules: [rule(ANA, MONDAY, "09:00", "09:30")],
        durationMin: 60,
      }),
      {
        from: "2026-06-15",
        to: "2026-06-15",
        now: clock("2026-06-01T00:00:00Z"),
      },
    );

    expect(result.slots).toEqual([]);
  });

  /** A 60-minute service cannot start 30 minutes before closing. */
  it("stops offering starts once the remaining time is too short", () => {
    const result = computeAvailability(
      context({
        rules: [rule(ANA, MONDAY, "09:00", "11:00")],
        durationMin: 60,
      }),
      {
        from: "2026-06-15",
        to: "2026-06-15",
        now: clock("2026-06-01T00:00:00Z"),
      },
    );

    // 10:00 local is the last start; 10:15 would end at 11:15.
    expect(starts(result).at(-1)).toBe("2026-06-15T08:00:00.000Z");
  });
});

describe("buffers", () => {
  const MONDAY = 1;

  /**
   * The buffers are part of the blocking window and the WHOLE window has to
   * fit. A cleanup that would run past closing is still work, and the day ends
   * when it ends.
   */
  it("shorten the last start of the day by the after-buffer", () => {
    const withBuffer = computeAvailability(
      context({
        rules: [rule(ANA, MONDAY, "09:00", "11:00")],
        durationMin: 60,
        bufferAfterMin: 15,
      }),
      {
        from: "2026-06-15",
        to: "2026-06-15",
        now: clock("2026-06-01T00:00:00Z"),
      },
    );

    // 09:45 local (07:45 UTC): the appointment ends at 10:45 and the cleanup
    // finishes exactly at 11:00. 10:00 would overrun.
    expect(starts(withBuffer).at(-1)).toBe("2026-06-15T07:45:00.000Z");
  });

  it("delay the first start of the day by the before-buffer", () => {
    const result = computeAvailability(
      context({
        rules: [rule(ANA, MONDAY, "09:00", "17:00")],
        durationMin: 60,
        bufferBeforeMin: 15,
      }),
      {
        from: "2026-06-15",
        to: "2026-06-15",
        now: clock("2026-06-01T00:00:00Z"),
      },
    );

    // The setup starts at 09:00; the customer arrives at 09:15.
    expect(starts(result)[0]).toBe("2026-06-15T07:15:00.000Z");
  });

  /**
   * THE ADJACENT-SLOT CASE. An appointment's stored `slot` already contains
   * its buffers, so the free time around it is genuinely smaller than the
   * customer-facing appointment suggests — and a slot that looks free is not.
   */
  it("block an adjacent slot that would otherwise be free", () => {
    const rules = [rule(ANA, MONDAY, "09:00", "13:00")];

    // A 10:00–11:00 appointment with 15 minutes of cleanup: the stored
    // blocking range is 10:00 to 11:15.
    const blocked: BlockedRow[] = [
      {
        staffId: ANA,
        startsAt: new Date("2026-06-15T08:00:00Z"), // 10:00 local
        endsAt: new Date("2026-06-15T09:15:00Z"), // 11:15 local
      },
    ];

    const result = computeAvailability(
      context({ rules, blocked, durationMin: 60 }),
      {
        from: "2026-06-15",
        to: "2026-06-15",
        now: clock("2026-06-01T00:00:00Z"),
      },
    );

    // 11:00 local looks free — the appointment ended — but the cleanup runs
    // until 11:15, so the next hour cannot start until 11:15.
    expect(starts(result)).not.toContain("2026-06-15T09:00:00.000Z");
    expect(starts(result)).toContain("2026-06-15T09:15:00.000Z");
  });

  it("leave the slot immediately before an appointment bookable", () => {
    const result = computeAvailability(
      context({
        rules: [rule(ANA, MONDAY, "09:00", "13:00")],
        blocked: [
          {
            staffId: ANA,
            startsAt: new Date("2026-06-15T08:00:00Z"), // 10:00 local
            endsAt: new Date("2026-06-15T09:00:00Z"), // 11:00 local
          },
        ],
        durationMin: 60,
      }),
      {
        from: "2026-06-15",
        to: "2026-06-15",
        now: clock("2026-06-01T00:00:00Z"),
      },
    );

    // Half-open ranges: an appointment starting at 10:00 does not collide with
    // one ending at 10:00.
    expect(starts(result)).toContain("2026-06-15T07:00:00.000Z");
  });
});

describe("the minimum lead time", () => {
  const MONDAY = 1;

  /**
   * THE EXACT BOUNDARY. With a two-hour lead time and the clock at 08:00
   * local, the 10:00 opening is offered and the 09:45 one is not.
   *
   * Tested by moving the CLOCK by one minute rather than the slot, because
   * that is the comparison the code makes and the direction a real request
   * arrives from.
   */
  const rules = [rule(ANA, MONDAY, "09:00", "17:00")];

  function at(nowIso: string) {
    return computeAvailability(
      context({ rules, minLeadTimeMin: 120, durationMin: 60 }),
      { from: "2026-06-15", to: "2026-06-15", now: clock(nowIso) },
    );
  }

  it("offers a slot exactly at the boundary", () => {
    // 08:00 local = 06:00 UTC. Two hours on: 10:00 local, 08:00 UTC.
    expect(starts(at("2026-06-15T06:00:00Z"))).toContain(
      "2026-06-15T08:00:00.000Z",
    );
  });

  it("does not offer it one minute later", () => {
    // 08:01 local pushes the earliest permissible start to 10:01, and 10:00
    // is now inside the lead time.
    expect(starts(at("2026-06-15T06:01:00Z"))).not.toContain(
      "2026-06-15T08:00:00.000Z",
    );
  });

  it("offers the next slot along once the boundary has passed", () => {
    expect(starts(at("2026-06-15T06:01:00Z"))[0]).toBe(
      "2026-06-15T08:15:00.000Z",
    );
  });

  it("reports the cutoff it applied", () => {
    expect(at("2026-06-15T06:00:00Z").policy.earliestStart).toBe(
      "2026-06-15T08:00:00.000Z",
    );
  });
});

describe("the maximum booking horizon", () => {
  const MONDAY = 1;

  const rules = [
    rule(ANA, MONDAY, "09:00", "17:00"),
    rule(ANA, 2, "09:00", "17:00"),
  ];

  /**
   * Counted in LOCAL CALENDAR DAYS, inclusive. With a horizon of one day and
   * the clock on Monday, Tuesday is bookable and Wednesday is not — regardless
   * of what time on Monday the question is asked.
   */
  it("includes the last permitted local day in full", () => {
    const result = computeAvailability(
      context({ rules, maxAdvanceDays: 1 }),
      {
        from: "2026-06-15",
        to: "2026-06-17",
        // Monday, late in the evening: 23:00 local.
        now: clock("2026-06-15T21:00:00Z"),
      },
    );

    // Tuesday's openings survive even though they are more than 24 hours away
    // from a clock reading late on Monday.
    expect(starts(result)).toContain("2026-06-16T07:00:00.000Z");
  });

  it("excludes the day after the horizon", () => {
    const result = computeAvailability(
      context({ rules, maxAdvanceDays: 1 }),
      {
        from: "2026-06-15",
        to: "2026-06-17",
        now: clock("2026-06-15T21:00:00Z"),
      },
    );

    // Wednesday is one day too far.
    expect(
      starts(result).some((instant) => instant.startsWith("2026-06-17")),
    ).toBe(false);
  });
});

/* ===========================================================================
   HOLDS AND CLOSURES
   =========================================================================== */

describe("holds", () => {
  const MONDAY = 1;
  const rules = [rule(ANA, MONDAY, "09:00", "13:00")];

  /** A hold on the 10:00 local slot, expiring at the given instant. */
  function heldUntil(): BlockedRow {
    return {
      staffId: ANA,
      startsAt: new Date("2026-06-15T08:00:00Z"), // 10:00 local
      endsAt: new Date("2026-06-15T09:00:00Z"), // 11:00 local
    };
  }

  /**
   * The engine is handed only LIVE blocking rows — the loader's query already
   * dropped expired holds, against the same injected clock. These two tests
   * pin down both halves of that contract.
   */
  it("removes the slot while the hold is live", () => {
    const result = computeAvailability(
      context({ rules, blocked: [heldUntil()], durationMin: 60 }),
      {
        from: "2026-06-15",
        to: "2026-06-15",
        now: clock("2026-06-15T05:00:00Z"),
      },
    );

    expect(starts(result)).not.toContain("2026-06-15T08:00:00.000Z");
  });

  it("leaves the slot open once the hold has lapsed and is not passed in", () => {
    const result = computeAvailability(
      context({ rules, blocked: [], durationMin: 60 }),
      {
        from: "2026-06-15",
        to: "2026-06-15",
        now: clock("2026-06-15T05:00:00Z"),
      },
    );

    expect(starts(result)).toContain("2026-06-15T08:00:00.000Z");
  });
});

describe("time off", () => {
  const MONDAY = 1;
  const rules = [rule(ANA, MONDAY, "09:00", "17:00"), rule(BO, MONDAY, "09:00", "17:00")];

  it("removes a staff member's own closure from their day", () => {
    const timeOff: TimeOffRow[] = [
      {
        staffId: ANA,
        startsAt: new Date("2026-06-15T10:00:00Z"), // 12:00 local
        endsAt: new Date("2026-06-15T12:00:00Z"), // 14:00 local
      },
    ];

    const result = computeAvailability(
      context({ rules, timeOff, staff: [TEAM[0]] }),
      {
        from: "2026-06-15",
        to: "2026-06-15",
        now: clock("2026-06-01T00:00:00Z"),
      },
    );

    expect(starts(result)).not.toContain("2026-06-15T10:00:00.000Z");
    expect(starts(result)).toContain("2026-06-15T12:00:00.000Z");
  });

  /** `staff_id IS NULL` closes the business, which is not the same fact. */
  it("removes a business-wide closure from everybody", () => {
    const timeOff: TimeOffRow[] = [
      {
        staffId: null,
        startsAt: new Date("2026-06-15T10:00:00Z"),
        endsAt: new Date("2026-06-15T12:00:00Z"),
      },
    ];

    const result = computeAvailability(context({ rules, timeOff, staff: TEAM }), {
      from: "2026-06-15",
      to: "2026-06-15",
      now: clock("2026-06-01T00:00:00Z"),
    });

    expect(starts(result)).not.toContain("2026-06-15T10:00:00.000Z");
  });

  it("leaves the other staff member alone when the closure is personal", () => {
    const timeOff: TimeOffRow[] = [
      {
        staffId: ANA,
        startsAt: new Date("2026-06-15T10:00:00Z"),
        endsAt: new Date("2026-06-15T12:00:00Z"),
      },
    ];

    const result = computeAvailability(context({ rules, timeOff, staff: TEAM }), {
      from: "2026-06-15",
      to: "2026-06-15",
      now: clock("2026-06-01T00:00:00Z"),
    });

    const noon = result.slots.find(
      (slot) => slot.startsAt === "2026-06-15T10:00:00.000Z",
    );

    expect(noon?.staffIds).toEqual([BO]);
  });
});

/* ===========================================================================
   'ANY' STAFF
   =========================================================================== */

describe("staffId: 'any'", () => {
  const MONDAY = 1;

  const rules = [
    rule(ANA, MONDAY, "09:00", "12:00"),
    rule(BO, MONDAY, "11:00", "14:00"),
  ];

  function anyStaff(blocked: BlockedRow[] = []) {
    return computeAvailability(
      context({ rules, staff: TEAM, blocked, durationMin: 60 }),
      {
        from: "2026-06-15",
        to: "2026-06-15",
        now: clock("2026-06-01T00:00:00Z"),
      },
    );
  }

  it("unions the openings across everyone qualified", () => {
    // Ana covers 09:00–12:00, Bo covers 11:00–14:00: together 09:00–14:00,
    // so hour-long starts run from 09:00 to 13:00 local.
    expect(starts(anyStaff())[0]).toBe("2026-06-15T07:00:00.000Z");
    expect(starts(anyStaff()).at(-1)).toBe("2026-06-15T11:00:00.000Z");
  });

  it("names both people at an instant they are both free", () => {
    const eleven = anyStaff().slots.find(
      (slot) => slot.startsAt === "2026-06-15T09:00:00.000Z",
    );

    // 11:00 local sits inside both shifts.
    expect(eleven?.staffIds).toEqual([ANA, BO]);
  });

  it("names only the person who is free at an instant the other is not", () => {
    const nine = anyStaff().slots.find(
      (slot) => slot.startsAt === "2026-06-15T07:00:00.000Z",
    );

    expect(nine?.staffIds).toEqual([ANA]);
  });

  /** The headline case: one person busy does not close the slot. */
  it("still returns a slot when only one qualified person is free", () => {
    const result = anyStaff([
      {
        staffId: ANA,
        startsAt: new Date("2026-06-15T09:00:00Z"), // 11:00 local
        endsAt: new Date("2026-06-15T10:00:00Z"), // 12:00 local
      },
    ]);

    const eleven = result.slots.find(
      (slot) => slot.startsAt === "2026-06-15T09:00:00.000Z",
    );

    expect(eleven).toBeDefined();
    expect(eleven?.staffIds).toEqual([BO]);
  });

  it("closes the slot only when everybody is busy", () => {
    const result = anyStaff([
      {
        staffId: ANA,
        startsAt: new Date("2026-06-15T09:00:00Z"),
        endsAt: new Date("2026-06-15T10:00:00Z"),
      },
      {
        staffId: BO,
        startsAt: new Date("2026-06-15T09:00:00Z"),
        endsAt: new Date("2026-06-15T10:00:00Z"),
      },
    ]);

    expect(starts(result)).not.toContain("2026-06-15T09:00:00.000Z");
  });
});

/* ===========================================================================
   EFFECTIVE DATING, INACTIVE RECORDS AND THE GRID
   =========================================================================== */

describe("effective dating", () => {
  const MONDAY = 1;

  it("uses the version in force on each day, not the newest one", () => {
    const rules = [
      rule(ANA, MONDAY, "09:00", "17:00", { to: "2026-06-15" }),
      rule(ANA, MONDAY, "08:00", "17:00", { from: "2026-06-16" }),
    ];

    const first = computeAvailability(context({ rules }), {
      from: "2026-06-15",
      to: "2026-06-15",
      now: clock("2026-06-01T00:00:00Z"),
    });

    const later = computeAvailability(context({ rules }), {
      from: "2026-06-22",
      to: "2026-06-22",
      now: clock("2026-06-01T00:00:00Z"),
    });

    // 15 June opens at 09:00 local (07:00 UTC); 22 June at 08:00 (06:00 UTC).
    expect(starts(first)[0]).toBe("2026-06-15T07:00:00.000Z");
    expect(starts(later)[0]).toBe("2026-06-22T06:00:00.000Z");
  });

  it("ignores a version that has not started yet", () => {
    const rules = [rule(ANA, MONDAY, "09:00", "17:00", { from: "2027-01-01" })];

    const result = computeAvailability(context({ rules }), {
      from: "2026-06-15",
      to: "2026-06-15",
      now: clock("2026-06-01T00:00:00Z"),
    });

    expect(result.slots).toEqual([]);
  });
});

describe("inactive records", () => {
  const MONDAY = 1;

  it("offers nothing for a switched-off service", () => {
    const result = computeAvailability(
      context({ rules: [rule(ANA, MONDAY, "09:00", "17:00")], isActive: false }),
      {
        from: "2026-06-15",
        to: "2026-06-15",
        now: clock("2026-06-01T00:00:00Z"),
      },
    );

    expect(result.slots).toEqual([]);
  });

  it("offers nothing when nobody is qualified", () => {
    const result = computeAvailability(
      context({ rules: [rule(ANA, MONDAY, "09:00", "17:00")], staff: [] }),
      {
        from: "2026-06-15",
        to: "2026-06-15",
        now: clock("2026-06-01T00:00:00Z"),
      },
    );

    expect(result.slots).toEqual([]);
  });

  it("still reports the policy it would have applied", () => {
    const result = computeAvailability(
      context({ minLeadTimeMin: 120, isActive: false }),
      {
        from: "2026-06-15",
        to: "2026-06-15",
        now: clock("2026-06-15T06:00:00Z"),
      },
    );

    // An empty calendar has to be explicable, so the bounds come back even
    // when the list does not.
    expect(result.policy.earliestStart).toBe("2026-06-15T08:00:00.000Z");
  });
});

describe("the slot grid", () => {
  const MONDAY = 1;

  it("aligns openings to the business's granularity", () => {
    const result = computeAvailability(
      context({
        rules: [rule(ANA, MONDAY, "09:00", "12:00")],
        slotGranularityMin: 30,
        durationMin: 60,
      }),
      {
        from: "2026-06-15",
        to: "2026-06-15",
        now: clock("2026-06-01T00:00:00Z"),
      },
    );

    expect(starts(result)).toEqual([
      "2026-06-15T07:00:00.000Z", // 09:00
      "2026-06-15T07:30:00.000Z", // 09:30
      "2026-06-15T08:00:00.000Z", // 10:00
      "2026-06-15T08:30:00.000Z", // 10:30
      "2026-06-15T09:00:00.000Z", // 11:00
    ]);
  });

  /**
   * After a subtraction the free time can start off the grid. The next offer
   * rounds UP onto it — never down, which would overlap what was just
   * subtracted.
   */
  it("rounds a mid-grid free interval up to the next grid point", () => {
    const result = computeAvailability(
      context({
        rules: [rule(ANA, MONDAY, "09:00", "13:00")],
        blocked: [
          {
            staffId: ANA,
            startsAt: new Date("2026-06-15T07:00:00Z"), // 09:00 local
            endsAt: new Date("2026-06-15T08:20:00Z"), // 10:20 local
          },
        ],
        durationMin: 60,
      }),
      {
        from: "2026-06-15",
        to: "2026-06-15",
        now: clock("2026-06-01T00:00:00Z"),
      },
    );

    // Free from 10:20; the first offer is 10:30, not 10:20.
    expect(starts(result)[0]).toBe("2026-06-15T08:30:00.000Z");
  });
});

/* ===========================================================================
   THE SET ALGEBRA, DIRECTLY
   =========================================================================== */

describe("subtractSpans", () => {
  it("splits a span when a cut lands in the middle", () => {
    expect(subtractSpans([{ start: 0, end: 100 }], [{ start: 40, end: 60 }])).toEqual(
      [
        { start: 0, end: 40 },
        { start: 60, end: 100 },
      ],
    );
  });

  it("removes a span entirely when the cut covers it", () => {
    expect(
      subtractSpans([{ start: 10, end: 20 }], [{ start: 0, end: 100 }]),
    ).toEqual([]);
  });

  it("leaves a span alone when the cut merely touches its edge", () => {
    // Half-open: a cut ending exactly where the span starts removes nothing.
    expect(
      subtractSpans([{ start: 10, end: 20 }], [{ start: 0, end: 10 }]),
    ).toEqual([{ start: 10, end: 20 }]);
  });

  it("applies several cuts in any order", () => {
    expect(
      subtractSpans(
        [{ start: 0, end: 100 }],
        [
          { start: 60, end: 70 },
          { start: 20, end: 30 },
        ],
      ),
    ).toEqual([
      { start: 0, end: 20 },
      { start: 30, end: 60 },
      { start: 70, end: 100 },
    ]);
  });
});
