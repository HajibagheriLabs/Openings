import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/db/client";
import { availabilityRules, serviceStaff, timeOff } from "@/db/schema";
import { loadMonthSummary } from "@/lib/scheduling/month-summary";
import { setupTestDatabase, type TestContext } from "./helpers/database";

/**
 * The month the booking calendar draws.
 *
 * These are the questions the month picker actually asks, and each one has a
 * way of being wrong that a customer would notice: a day offered that has
 * nothing on it, a day greyed out that is free, a calendar that lets you page
 * past the business's horizon, and an empty month with no way forward.
 *
 * The fixture business is Europe/Berlin. September 2026 has no DST transition,
 * so local time is UTC+02:00 all month and the instants below read plainly.
 */

let context: TestContext;
let db: Db;

/** Weekday 2 — Tuesday, matching Postgres `extract(dow)`. */
const TUESDAY = 2;

/** A Tuesday in September 2026, with the whole month still ahead of it. */
const NOW = new Date("2026-09-01T06:00:00Z");

const TIME_ZONE = "Europe/Berlin";

beforeAll(async () => {
  context = await setupTestDatabase();
  db = context.db;

  await db.execute(sql`
    UPDATE businesses
       SET min_lead_time_min = 0, max_advance_days = 60
     WHERE id = ${context.businessId}
  `);
});

afterAll(async () => {
  await context.pool.end();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE appointments RESTART IDENTITY CASCADE`);
  await db.delete(availabilityRules);
  await db.delete(serviceStaff);
  await db.delete(timeOff);
});

/** Ana works Tuesdays, nine to five, and performs the plain service. */
async function openTuesdays() {
  await db.insert(serviceStaff).values({
    serviceId: context.plainServiceId,
    staffId: context.staffA,
  });

  await db.insert(availabilityRules).values({
    staffId: context.staffA,
    weekday: TUESDAY,
    startLocal: "09:00",
    endLocal: "17:00",
    effectiveFrom: "2026-01-01",
  });
}

function summarise(month: string, now: Date = NOW) {
  return loadMonthSummary({
    db,
    businessId: context.businessId,
    serviceId: context.plainServiceId,
    staffId: "any",
    timeZone: TIME_ZONE,
    maxAdvanceDays: 60,
    month,
    now,
  });
}

describe("loadMonthSummary", () => {
  it("returns every day of the month, opened only where hours exist", async () => {
    await openTuesdays();

    const summary = await summarise("2026-09");

    expect(summary).not.toBeNull();
    expect(summary?.days).toHaveLength(30);

    const open = summary!.days.filter((day) => day.openings > 0);

    // September 2026: Tuesdays are the 1st, 8th, 15th, 22nd and 29th. The
    // 1st is today and the lead time is zero, but the clock is 08:00 local —
    // so it still has most of the day left.
    expect(open.map((day) => day.date)).toEqual([
      "2026-09-01",
      "2026-09-08",
      "2026-09-15",
      "2026-09-22",
      "2026-09-29",
    ]);

    // Nine to five, a 60-minute service, no buffers, on a 15-minute grid: the
    // last start that still fits is 16:00.
    const eighth = summary!.days.find((day) => day.date === "2026-09-08");
    expect(eighth?.openings).toBe(29);
    expect(eighth?.firstStartsAt).toBe("2026-09-08T07:00:00.000Z");
  });

  it("reports the horizon as local dates and months", async () => {
    await openTuesdays();

    const summary = await summarise("2026-09");

    expect(summary?.horizon).toEqual({
      from: "2026-09-01",
      to: "2026-10-31",
      firstMonth: "2026-09",
      lastMonth: "2026-10",
    });
  });

  it("closes days that are behind today, without touching the rest", async () => {
    await openTuesdays();

    // Mid-month, after the 8th has gone.
    const summary = await summarise("2026-09", new Date("2026-09-10T06:00:00Z"));

    const open = summary!.days.filter((day) => day.openings > 0);

    expect(open.map((day) => day.date)).toEqual([
      "2026-09-15",
      "2026-09-22",
      "2026-09-29",
    ]);
  });

  it("subtracts a closure from the day it covers", async () => {
    await openTuesdays();

    await db.execute(sql`
      INSERT INTO time_off (business_id, staff_id, range, reason, is_all_day)
      VALUES (
        ${context.businessId},
        ${context.staffA},
        tstzrange(
          '2026-09-15T00:00:00+02:00'::timestamptz,
          '2026-09-16T00:00:00+02:00'::timestamptz,
          '[)'
        ),
        'Away',
        true
      )
    `);

    const summary = await summarise("2026-09");

    expect(
      summary!.days.find((day) => day.date === "2026-09-15")?.openings,
    ).toBe(0);
    expect(
      summary!.days.find((day) => day.date === "2026-09-22")?.openings,
    ).toBeGreaterThan(0);
  });

  it("clamps a month behind today onto the current one", async () => {
    await openTuesdays();

    // A link sent in August, opened in September. Faithfully rendering an
    // August whose every day is in the past would be a dead end.
    const summary = await summarise("2026-08");

    expect(summary?.month).toBe("2026-09");
    expect(summary?.openings).toBeGreaterThan(0);
  });

  it("clamps a month past the horizon onto the last bookable one", async () => {
    await openTuesdays();

    const summary = await summarise("2027-04");

    expect(summary?.month).toBe("2026-10");
  });

  it("finds the next opening when the month is empty, and only then", async () => {
    await openTuesdays();

    const september = await summarise("2026-09");
    // A month with openings never pays for the second query.
    expect(september?.openings).toBeGreaterThan(0);
    expect(september?.nextOpen).toBeNull();

    // Close the whole of September for the whole business.
    await db.execute(sql`
      INSERT INTO time_off (business_id, staff_id, range, reason, is_all_day)
      VALUES (
        ${context.businessId},
        NULL,
        tstzrange(
          '2026-09-01T00:00:00+02:00'::timestamptz,
          '2026-10-01T00:00:00+02:00'::timestamptz,
          '[)'
        ),
        'Closed for September',
        true
      )
    `);

    const closed = await summarise("2026-09");

    expect(closed?.openings).toBe(0);
    // October 2026 starts on a Thursday, so its first Tuesday is the 6th.
    expect(closed?.nextOpen).toEqual({
      date: "2026-10-06",
      month: "2026-10",
      startsAt: "2026-10-06T07:00:00.000Z",
    });
  });

  it("has no shortcut to offer when the rest of the horizon is empty too", async () => {
    await openTuesdays();

    // Everything from today to past the 60-day horizon.
    await db.execute(sql`
      INSERT INTO time_off (business_id, staff_id, range, reason, is_all_day)
      VALUES (
        ${context.businessId},
        NULL,
        tstzrange(
          '2026-09-01T00:00:00+02:00'::timestamptz,
          '2026-12-01T00:00:00+02:00'::timestamptz,
          '[)'
        ),
        'Closed',
        true
      )
    `);

    const summary = await summarise("2026-09");

    expect(summary?.openings).toBe(0);
    expect(summary?.nextOpen).toBeNull();
  });

  it("is empty, not broken, when nobody performs the service", async () => {
    const summary = await summarise("2026-09");

    expect(summary?.openings).toBe(0);
    expect(summary?.days).toHaveLength(30);
  });

  it("returns null for a service that is not this business's", async () => {
    const summary = await loadMonthSummary({
      db,
      businessId: context.businessId,
      serviceId: "00000000-0000-0000-0000-000000000000",
      staffId: "any",
      timeZone: TIME_ZONE,
      maxAdvanceDays: 60,
      month: "2026-09",
      now: NOW,
    });

    expect(summary).toBeNull();
  });
});
