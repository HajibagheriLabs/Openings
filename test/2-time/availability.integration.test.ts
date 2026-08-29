import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/db/client";
import { availabilityRules, serviceStaff, timeOff } from "@/db/schema";
import { getAvailability } from "@/lib/scheduling/availability";
import { buildBlockingRange } from "@/lib/scheduling/slot";
import { resolveTimeOffRange } from "@/lib/scheduling/time-off";
import { setupTestDatabase, type TestContext } from "../helpers/database";

/**
 * The LOADER half of the availability algorithm.
 *
 * The unit suite proves the arithmetic with data handed to it directly. It
 * cannot prove that the five queries fetch the right rows — that the
 * effective-date filter is inclusive at both ends, that `&&` against the
 * stored `slot` finds the appointment, or that the injected clock really
 * reaches the SQL that decides which holds have expired. Those are database
 * facts, so they are tested against a database.
 *
 * The fixture business is Europe/Berlin. 15 September 2026 is a Tuesday,
 * comfortably clear of any DST transition, so the instants below read plainly:
 * local time is UTC+02:00 all day.
 */

let context: TestContext;
let db: Db;

/** Weekday 2 — Tuesday, matching Postgres `extract(dow)`. */
const TUESDAY = 2;
const DAY = "2026-09-15";

/**
 * A fixed clock, well before the day under test and far enough ahead of it to
 * clear the default two-hour lead time without relying on it.
 */
const NOW = new Date("2026-09-01T09:00:00Z");

beforeAll(async () => {
  context = await setupTestDatabase();
  db = context.db;

  // The fixture business ships with a two-hour lead time. These tests are
  // about the queries, not the policy, so it is taken out of the way.
  await db.execute(sql`
    UPDATE businesses SET min_lead_time_min = 0 WHERE id = ${context.businessId}
  `);
});

afterAll(async () => {
  await context.pool.end();
});

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE appointments, availability_rules, service_staff
    RESTART IDENTITY CASCADE
  `);
  await db.execute(sql`TRUNCATE TABLE time_off RESTART IDENTITY CASCADE`);
  await db.execute(sql`UPDATE staff SET is_active = true`);
});

/** Give a staff member 09:00–17:00 local on Tuesdays, open-ended. */
async function giveHours(staffId: string): Promise<void> {
  await db.insert(availabilityRules).values({
    staffId,
    weekday: TUESDAY,
    startLocal: "09:00:00",
    endLocal: "17:00:00",
    effectiveFrom: "2020-01-01",
  });
}

/** Say a staff member can perform the plain 60-minute service. */
async function qualify(staffId: string): Promise<void> {
  await db
    .insert(serviceStaff)
    .values({ serviceId: context.plainServiceId, staffId });
}

async function insertAppointment(
  staffId: string,
  startsAt: Date,
  status: "confirmed" | "held",
  holdExpiresAt: Date | null = null,
): Promise<void> {
  const range = buildBlockingRange(startsAt, {
    durationMin: 60,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
  });

  await db.execute(sql`
    INSERT INTO appointments (
      business_id, staff_id, service_id, customer_id,
      slot, starts_at, ends_at, status, hold_expires_at,
      price_cents, ics_uid, manage_token_hash
    ) VALUES (
      ${context.businessId}, ${staffId}, ${context.plainServiceId},
      ${context.customerId}, ${range.slot}::tstzrange,
      ${range.startsAt.toISOString()}, ${range.endsAt.toISOString()},
      ${status}, ${holdExpiresAt ? holdExpiresAt.toISOString() : null},
      9000, ${`ics-${crypto.randomUUID()}`}, ${"hash"}
    )
  `);
}

function ask(staffId: string | "any", serviceId = context.plainServiceId) {
  return getAvailability({
    db,
    businessId: context.businessId,
    serviceId,
    staffId,
    from: DAY,
    to: DAY,
    now: NOW,
  });
}

describe("loading availability", () => {
  it("returns null for a service that does not belong to the business", async () => {
    const result = await getAvailability({
      db,
      businessId: crypto.randomUUID(),
      serviceId: context.plainServiceId,
      staffId: "any",
      from: DAY,
      to: DAY,
      now: NOW,
    });

    expect(result).toBeNull();
  });

  it("returns the business timezone alongside the openings", async () => {
    await giveHours(context.staffA);
    await qualify(context.staffA);

    const result = await ask(context.staffA);

    expect(result?.timeZone).toBe("Europe/Berlin");
  });

  it("expands the stored rules into instants", async () => {
    await giveHours(context.staffA);
    await qualify(context.staffA);

    const result = await ask(context.staffA);

    // 09:00 local in September is CEST, +02:00 — so 07:00 UTC. The last
    // hour-long start is 16:00 local, 14:00 UTC.
    expect(result?.slots[0].startsAt).toBe("2026-09-15T07:00:00.000Z");
    expect(result?.slots.at(-1)?.startsAt).toBe("2026-09-15T14:00:00.000Z");
  });

  it("offers nothing when nobody is qualified for the service", async () => {
    await giveHours(context.staffA);
    // Deliberately no service_staff row.

    const result = await ask("any");

    expect(result?.slots).toEqual([]);
  });

  it("offers nothing for a staff member with no hours", async () => {
    await qualify(context.staffA);

    const result = await ask(context.staffA);

    expect(result?.slots).toEqual([]);
  });

  it("excludes a deactivated staff member", async () => {
    await giveHours(context.staffA);
    await qualify(context.staffA);

    await db.execute(
      sql`UPDATE staff SET is_active = false WHERE id = ${context.staffA}`,
    );

    const result = await ask("any");

    expect(result?.slots).toEqual([]);
  });
});

describe("subtracting what is already taken", () => {
  beforeEach(async () => {
    await giveHours(context.staffA);
    await qualify(context.staffA);
  });

  it("removes a confirmed appointment's slot", async () => {
    // 10:00 local = 08:00 UTC.
    await insertAppointment(
      context.staffA,
      new Date("2026-09-15T08:00:00Z"),
      "confirmed",
    );

    const result = await ask(context.staffA);
    const openings = result!.slots.map((slot) => slot.startsAt);

    expect(openings).not.toContain("2026-09-15T08:00:00.000Z");
    expect(openings).toContain("2026-09-15T07:00:00.000Z");
  });

  /**
   * The injected clock has to reach the SQL. If the query used Postgres
   * `now()` instead, this hold — which expires long before the test's own
   * `now` — would still be treated as live and the assertion would flip.
   */
  it("ignores a hold that has expired as of the injected clock", async () => {
    await insertAppointment(
      context.staffA,
      new Date("2026-09-15T08:00:00Z"),
      "held",
      // One minute before NOW.
      new Date(NOW.getTime() - 60_000),
    );

    const result = await ask(context.staffA);

    expect(result!.slots.map((slot) => slot.startsAt)).toContain(
      "2026-09-15T08:00:00.000Z",
    );
  });

  it("respects a hold that is still live as of the injected clock", async () => {
    await insertAppointment(
      context.staffA,
      new Date("2026-09-15T08:00:00Z"),
      "held",
      new Date(NOW.getTime() + 8 * 60_000),
    );

    const result = await ask(context.staffA);

    expect(result!.slots.map((slot) => slot.startsAt)).not.toContain(
      "2026-09-15T08:00:00.000Z",
    );
  });

  it("removes an all-day business-wide closure", async () => {
    const resolved = resolveTimeOffRange(
      { startDate: DAY, endDate: DAY, isAllDay: true },
      "Europe/Berlin",
    );

    if (!resolved.ok) {
      throw new Error(resolved.message);
    }

    await db.insert(timeOff).values({
      businessId: context.businessId,
      staffId: null,
      range: resolved.value.range,
      isAllDay: true,
    });

    const result = await ask(context.staffA);

    expect(result?.slots).toEqual([]);
  });

  it("removes a part-day closure for one person only", async () => {
    const resolved = resolveTimeOffRange(
      {
        startDate: DAY,
        endDate: DAY,
        startLocal: "12:00",
        endLocal: "14:00",
        isAllDay: false,
      },
      "Europe/Berlin",
    );

    if (!resolved.ok) {
      throw new Error(resolved.message);
    }

    await db.insert(timeOff).values({
      businessId: context.businessId,
      staffId: context.staffA,
      range: resolved.value.range,
      isAllDay: false,
    });

    const result = await ask(context.staffA);
    const openings = result!.slots.map((slot) => slot.startsAt);

    // 12:00 and 13:00 local are 10:00 and 11:00 UTC.
    expect(openings).not.toContain("2026-09-15T10:00:00.000Z");
    expect(openings).toContain("2026-09-15T12:00:00.000Z");
  });
});

describe("effective dating, in SQL", () => {
  it("ignores a rule version that has already been superseded", async () => {
    await qualify(context.staffA);

    await db.insert(availabilityRules).values([
      {
        staffId: context.staffA,
        weekday: TUESDAY,
        startLocal: "09:00:00",
        endLocal: "17:00:00",
        effectiveFrom: "2020-01-01",
        // Ends the day before the day under test.
        effectiveTo: "2026-09-14",
      },
      {
        staffId: context.staffA,
        weekday: TUESDAY,
        startLocal: "13:00:00",
        endLocal: "17:00:00",
        effectiveFrom: "2026-09-15",
      },
    ]);

    const result = await ask(context.staffA);

    // 13:00 local, not 09:00 — the newer version governs the day.
    expect(result?.slots[0].startsAt).toBe("2026-09-15T11:00:00.000Z");
  });

  it("keeps a version whose last day is the day being asked about", async () => {
    await qualify(context.staffA);

    await db.insert(availabilityRules).values({
      staffId: context.staffA,
      weekday: TUESDAY,
      startLocal: "09:00:00",
      endLocal: "17:00:00",
      effectiveFrom: "2020-01-01",
      // Inclusive: the rule still applies on this day.
      effectiveTo: DAY,
    });

    const result = await ask(context.staffA);

    expect(result?.slots[0].startsAt).toBe("2026-09-15T07:00:00.000Z");
  });
});

describe("staffId: 'any', against the database", () => {
  it("unions two people and names who is free at each instant", async () => {
    await giveHours(context.staffA);
    await giveHours(context.staffB);
    await qualify(context.staffA);
    await qualify(context.staffB);

    // Ana is booked at 10:00 local; Bo is not.
    await insertAppointment(
      context.staffA,
      new Date("2026-09-15T08:00:00Z"),
      "confirmed",
    );

    const result = await ask("any");
    const ten = result!.slots.find(
      (slot) => slot.startsAt === "2026-09-15T08:00:00.000Z",
    );
    const nine = result!.slots.find(
      (slot) => slot.startsAt === "2026-09-15T07:00:00.000Z",
    );

    // The slot survives because one qualified person is still free.
    expect(ten?.staffIds).toEqual([context.staffB]);
    expect(nine?.staffIds).toHaveLength(2);
  });

  it("narrows to one person when a specific staff member is asked for", async () => {
    await giveHours(context.staffA);
    await giveHours(context.staffB);
    await qualify(context.staffA);
    await qualify(context.staffB);

    const result = await ask(context.staffB);

    expect(result!.slots.every((slot) => slot.staffIds.length === 1)).toBe(true);
    expect(result!.slots[0].staffIds).toEqual([context.staffB]);
  });
});

describe("buffers come from the stored range", () => {
  /**
   * The buffered fixture service is 60 minutes with 15 before and 15 after, so
   * its blocking range is 90 minutes wide. Availability for the PLAIN service
   * still has to respect it — the block is a property of the appointment that
   * was made, not of the service being asked about.
   */
  it("blocks around an appointment made with a buffered service", async () => {
    await giveHours(context.staffA);
    await qualify(context.staffA);

    const range = buildBlockingRange(new Date("2026-09-15T08:00:00Z"), {
      durationMin: 60,
      bufferBeforeMin: 15,
      bufferAfterMin: 15,
    });

    await db.execute(sql`
      INSERT INTO appointments (
        business_id, staff_id, service_id, customer_id,
        slot, starts_at, ends_at, status,
        price_cents, ics_uid, manage_token_hash
      ) VALUES (
        ${context.businessId}, ${context.staffA}, ${context.bufferedServiceId},
        ${context.customerId}, ${range.slot}::tstzrange,
        ${range.startsAt.toISOString()}, ${range.endsAt.toISOString()},
        'confirmed', 15000, ${`ics-${crypto.randomUUID()}`}, ${"hash"}
      )
    `);

    const result = await ask(context.staffA);
    const openings = result!.slots.map((slot) => slot.startsAt);

    /**
     * The appointment runs 10:00–11:00 local, but its STORED RANGE is
     * 09:45–11:15 — the buffers are inside it.
     *
     * So an hour starting at 09:00 is refused: it would run to 10:00 and
     * overlap the 09:45 setup. And 11:00 is refused too, because the cleanup
     * runs until 11:15. The next offer is 11:15 rounded up onto the grid,
     * which is 11:30. None of this is visible in `starts_at`/`ends_at` — it is
     * why availability reads `slot` and nothing else.
     */
    expect(openings).not.toContain("2026-09-15T07:00:00.000Z"); // 09:00
    expect(openings).not.toContain("2026-09-15T09:00:00.000Z"); // 11:00
    expect(openings).toContain("2026-09-15T09:30:00.000Z"); // 11:30
  });
});
