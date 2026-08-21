import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/db/client";
import { availabilityRules, timeOff } from "@/db/schema";
import { buildBlockingRange } from "@/lib/scheduling/slot";
import { resolveTimeOffRange } from "@/lib/scheduling/time-off";
import { setupTestDatabase, type TestContext } from "./helpers/database";

/**
 * The parts of hours and time off that only Postgres can confirm.
 *
 * The unit tests prove the Temporal arithmetic. They cannot prove that the
 * `tstzrange` literal this project builds is one Postgres accepts, that the
 * instants survive the round trip unchanged, or that `&&` finds the
 * appointments the conflict warning promises to list. Those are database
 * facts, so they are tested against a database.
 */

let context: TestContext;
let db: Db;

beforeAll(async () => {
  context = await setupTestDatabase();
  db = context.db;
});

afterAll(async () => {
  await context.pool.end();
});

async function clearTimeOff(): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE time_off RESTART IDENTITY CASCADE`);
}

/** Insert an appointment directly — this suite is not about the booking path. */
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

/** The fixtures run in Europe/Berlin — see the test database helper. */
const BERLIN = "Europe/Berlin";

describe("an all-day range survives the database round trip", () => {
  beforeAll(clearTimeOff);

  it("stores and reads back the exact local day boundaries", async () => {
    const resolved = resolveTimeOffRange(
      { startDate: "2026-12-25", endDate: "2026-12-25", isAllDay: true },
      BERLIN,
    );

    if (!resolved.ok) {
      throw new Error(resolved.message);
    }

    const [row] = await db
      .insert(timeOff)
      .values({
        businessId: context.businessId,
        staffId: null,
        range: resolved.value.range,
        reason: "Christmas",
        isAllDay: true,
      })
      .returning({ id: timeOff.id });

    // Read the bounds back the way the query module does: with Postgres' own
    // lower() and upper(), not by parsing the literal in JavaScript.
    const result = await db.execute<{ lower: Date; upper: Date }>(sql`
      SELECT lower(range) AS lower, upper(range) AS upper
        FROM time_off
       WHERE id = ${row.id}
    `);

    const stored = result.rows[0];

    expect(new Date(stored.lower).toISOString()).toBe(
      "2026-12-24T23:00:00.000Z",
    );
    expect(new Date(stored.upper).toISOString()).toBe(
      "2026-12-25T23:00:00.000Z",
    );
  });

  it("is half-open, so consecutive all-day blocks do not overlap", async () => {
    await clearTimeOff();

    for (const date of ["2026-12-25", "2026-12-26"]) {
      const resolved = resolveTimeOffRange(
        { startDate: date, endDate: date, isAllDay: true },
        BERLIN,
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
    }

    // Postgres itself is the authority on whether they touch or overlap.
    const result = await db.execute<{ overlapping: number }>(sql`
      SELECT count(*)::int AS overlapping
        FROM time_off a
        JOIN time_off b ON a.id < b.id AND a.range && b.range
    `);

    expect(result.rows[0].overlapping).toBe(0);
  });

  /**
   * The 25-hour local day. A range built as start + 24 hours would end an hour
   * early, and Postgres would agree that 23:30 local was still bookable.
   */
  it("covers the whole of a 25-hour fall-back day, per Postgres", async () => {
    await clearTimeOff();

    const resolved = resolveTimeOffRange(
      { startDate: "2026-10-25", endDate: "2026-10-25", isAllDay: true },
      BERLIN,
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

    // 23:30 local on the closed day, expressed as the instant it really is.
    const result = await db.execute<{ covered: boolean }>(sql`
      SELECT range @> timestamptz '2026-10-25 23:30:00+01' AS covered
        FROM time_off
       LIMIT 1
    `);

    expect(result.rows[0].covered).toBe(true);
  });
});

describe("conflict detection", () => {
  beforeAll(async () => {
    await clearTimeOff();
    await db.execute(sql`TRUNCATE TABLE appointments RESTART IDENTITY CASCADE`);
  });

  it("finds a confirmed appointment inside a blocked range", async () => {
    // 2026-09-15 is a plain Tuesday, no DST anywhere near it.
    await insertAppointment(
      context.staffA,
      new Date("2026-09-15T10:00:00+02:00"),
      "confirmed",
    );

    const resolved = resolveTimeOffRange(
      { startDate: "2026-09-15", endDate: "2026-09-15", isAllDay: true },
      BERLIN,
    );

    if (!resolved.ok) {
      throw new Error(resolved.message);
    }

    const result = await db.execute<{ hits: number }>(sql`
      SELECT count(*)::int AS hits
        FROM appointments
       WHERE business_id = ${context.businessId}
         AND slot && ${resolved.value.range}::tstzrange
         AND (
           status = 'confirmed'
           OR (status = 'held' AND hold_expires_at > now())
         )
    `);

    expect(result.rows[0].hits).toBe(1);
  });

  /**
   * An EXPIRED hold is not a conflict. It blocks nothing in the availability
   * query either, and warning about one would train the owner to click
   * straight through the warning that matters.
   */
  it("ignores an expired hold", async () => {
    await db.execute(sql`TRUNCATE TABLE appointments RESTART IDENTITY CASCADE`);

    await insertAppointment(
      context.staffA,
      new Date("2026-09-15T10:00:00+02:00"),
      "held",
      new Date(Date.now() - 60_000),
    );

    const resolved = resolveTimeOffRange(
      { startDate: "2026-09-15", endDate: "2026-09-15", isAllDay: true },
      BERLIN,
    );

    if (!resolved.ok) {
      throw new Error(resolved.message);
    }

    const result = await db.execute<{ hits: number }>(sql`
      SELECT count(*)::int AS hits
        FROM appointments
       WHERE slot && ${resolved.value.range}::tstzrange
         AND (
           status = 'confirmed'
           OR (status = 'held' AND hold_expires_at > now())
         )
    `);

    expect(result.rows[0].hits).toBe(0);
  });

  it("counts a live hold as a conflict", async () => {
    await db.execute(sql`TRUNCATE TABLE appointments RESTART IDENTITY CASCADE`);

    await insertAppointment(
      context.staffA,
      new Date("2026-09-15T10:00:00+02:00"),
      "held",
      new Date(Date.now() + 8 * 60_000),
    );

    const resolved = resolveTimeOffRange(
      { startDate: "2026-09-15", endDate: "2026-09-15", isAllDay: true },
      BERLIN,
    );

    if (!resolved.ok) {
      throw new Error(resolved.message);
    }

    const result = await db.execute<{ hits: number }>(sql`
      SELECT count(*)::int AS hits
        FROM appointments
       WHERE slot && ${resolved.value.range}::tstzrange
         AND (
           status = 'confirmed'
           OR (status = 'held' AND hold_expires_at > now())
         )
    `);

    expect(result.rows[0].hits).toBe(1);
  });

  it("does not report an appointment that merely touches the boundary", async () => {
    await db.execute(sql`TRUNCATE TABLE appointments RESTART IDENTITY CASCADE`);

    // Ends exactly at local midnight, where the next day's block begins.
    await insertAppointment(
      context.staffA,
      new Date("2026-09-15T23:00:00+02:00"),
      "confirmed",
    );

    const resolved = resolveTimeOffRange(
      { startDate: "2026-09-16", endDate: "2026-09-16", isAllDay: true },
      BERLIN,
    );

    if (!resolved.ok) {
      throw new Error(resolved.message);
    }

    const result = await db.execute<{ hits: number }>(sql`
      SELECT count(*)::int AS hits
        FROM appointments
       WHERE slot && ${resolved.value.range}::tstzrange
         AND status = 'confirmed'
    `);

    expect(result.rows[0].hits).toBe(0);
  });
});

describe("availability rules are stored as wall-clock times", () => {
  it("keeps a night shift as end < start rather than normalising it", async () => {
    await db.execute(
      sql`TRUNCATE TABLE availability_rules RESTART IDENTITY CASCADE`,
    );

    await db.insert(availabilityRules).values({
      staffId: context.staffA,
      weekday: 1,
      startLocal: "22:00:00",
      endLocal: "02:00:00",
      effectiveFrom: "2026-01-01",
    });

    const [row] = await db.select().from(availabilityRules);

    // The database stores exactly what it was given. The carry into the next
    // day is the expansion's job, not the column's.
    expect(row.startLocal).toBe("22:00:00");
    expect(row.endLocal).toBe("02:00:00");
  });

  it("accepts several intervals on one weekday, which is how a break is stored", async () => {
    await db.execute(
      sql`TRUNCATE TABLE availability_rules RESTART IDENTITY CASCADE`,
    );

    await db.insert(availabilityRules).values([
      {
        staffId: context.staffA,
        weekday: 1,
        startLocal: "09:00:00",
        endLocal: "13:00:00",
        effectiveFrom: "2026-01-01",
      },
      {
        staffId: context.staffA,
        weekday: 1,
        startLocal: "14:00:00",
        endLocal: "18:00:00",
        effectiveFrom: "2026-01-01",
      },
    ]);

    const rows = await db.select().from(availabilityRules);

    expect(rows).toHaveLength(2);
  });
});
