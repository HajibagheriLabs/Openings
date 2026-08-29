import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CHECK_VIOLATION, findPostgresError } from "@/db/errors";
import { withDemoBypass } from "@/server/demo/guard";
import { SEED_ICS_DOMAIN, tidyDemoBookings } from "@/server/demo/tidy";
import { createHold } from "@/lib/scheduling/booking";
import {
  at,
  clearAppointments,
  setupTestDatabase,
  type TestContext,
} from "../helpers/database";

/**
 * The demo workspace's guarantees, against a real Postgres.
 *
 * ═══ WHY THESE ARE INTEGRATION TESTS ═══
 *
 * Every rule here is enforced by a DATABASE TRIGGER (migration 0013), not by
 * application code. That is the whole point of them: the demo is a URL anybody
 * on the internet can click, and "no Server Action written next month will
 * forget this" is not a promise a codebase can make about itself. A unit test
 * with a mocked database would prove nothing at all about a rule that lives in
 * plpgsql, so these run the real statements against the real constraint.
 */

let context: TestContext;

beforeAll(async () => {
  context = await setupTestDatabase();
});

afterAll(async () => {
  await context.pool.end();
});

/** Mark the fixture business as scenery, and clear the diary. */
beforeEach(async () => {
  await clearAppointments(context.db);

  await context.db.execute(sql`
    UPDATE businesses SET is_demo = true WHERE id = ${context.businessId}
  `);
});

/** True when Postgres refused with the trigger's `check_violation`. */
function isRefusal(error: unknown): boolean {
  return findPostgresError(error, CHECK_VIOLATION) !== null;
}

async function expectRefused(run: () => Promise<unknown>): Promise<void> {
  await expect(run()).rejects.toSatisfy(
    isRefusal,
    "expected a check_violation from the demo guard",
  );
}

describe("the demo workspace refuses", () => {
  it("a change to the timezone — the thing the demo exists to show", async () => {
    /* Two businesses in two zones is the demonstration. Re-zoning one would
       silently change what every appointment already on its calendar means. */
    await expectRefused(() =>
      context.db.execute(sql`
        UPDATE businesses SET timezone = 'UTC' WHERE id = ${context.businessId}
      `),
    );
  });

  it("a change to the slug or the currency", async () => {
    await expectRefused(() =>
      context.db.execute(sql`
        UPDATE businesses SET slug = 'taken' WHERE id = ${context.businessId}
      `),
    );

    await expectRefused(() =>
      context.db.execute(sql`
        UPDATE businesses SET currency = 'GBP' WHERE id = ${context.businessId}
      `),
    );
  });

  it("deleting the business, its services, its staff or its customers", async () => {
    /**
     * WITH AN EMPTY DIARY, and that is the point of saying so.
     *
     * `appointments` references services, staff and customers with ON DELETE
     * RESTRICT, so a row with a single appointment against it cannot be
     * deleted whether or not this is a demo — and a test that left one behind
     * would pass on the foreign key while proving nothing about the guard it
     * claims to be testing. Cleared explicitly here so the only thing that can
     * refuse these four statements is the demo trigger.
     */
    const [diary] = (
      await context.db.execute(sql`SELECT count(*)::int AS n FROM appointments`)
    ).rows as { n: number }[];

    expect(diary.n).toBe(0);

    for (const statement of [
      sql`DELETE FROM businesses WHERE id = ${context.businessId}`,
      sql`DELETE FROM services WHERE id = ${context.plainServiceId}`,
      sql`DELETE FROM staff WHERE id = ${context.staffA}`,
      sql`DELETE FROM customers WHERE id = ${context.customerId}`,
    ]) {
      await expectRefused(() => context.db.execute(statement));
    }
  });
});

describe("the demo workspace still allows", () => {
  it("every setting that is not pinned", async () => {
    /* A demo you cannot change is a screenshot. Only the three fields that
       would break the demonstration are fixed. */
    await context.db.execute(sql`
      UPDATE businesses
         SET reminder_lead_min = 90, name = 'Renamed In The Demo'
       WHERE id = ${context.businessId}
    `);

    const [row] = (
      await context.db.execute(sql`
        SELECT reminder_lead_min FROM businesses WHERE id = ${context.businessId}
      `)
    ).rows as { reminder_lead_min: number }[];

    expect(row.reminder_lead_min).toBe(90);
  });

  it("booking, and deleting the hold that booking left behind", async () => {
    /* `time_off` and `appointments` are deliberately NOT guarded: blocking
       time and undoing it, editing hours, and the hold janitor all delete
       rows, and a demo where none of that worked would demonstrate nothing. */
    const held = await createHold(context.db, {
      businessId: context.businessId,
      staffId: context.staffA,
      serviceId: context.plainServiceId,
      startsAt: at(10),
    });

    await expect(
      context.db.execute(sql`
        DELETE FROM appointments WHERE id = ${held.appointment.id}
      `),
    ).resolves.toBeDefined();
  });
});

describe("the bypass", () => {
  it("lets the seed and the nightly sweep through, and only inside their transaction", async () => {
    await context.db.transaction(async (tx) => {
      await withDemoBypass(tx, async () => {
        await tx.execute(sql`
          UPDATE businesses SET timezone = 'UTC' WHERE id = ${context.businessId}
        `);
      });
    });

    const [row] = (
      await context.db.execute(sql`
        SELECT timezone FROM businesses WHERE id = ${context.businessId}
      `)
    ).rows as { timezone: string }[];

    expect(row.timezone).toBe("UTC");

    /* `SET LOCAL` is released on commit, so the very next statement on a
       connection from the same pool is guarded again. If it leaked, a request
       that happened to reuse the connection would be able to dismantle the
       demo. */
    await expectRefused(() =>
      context.db.execute(sql`
        UPDATE businesses SET timezone = 'Europe/Berlin'
         WHERE id = ${context.businessId}
      `),
    );
  });
});

describe("the nightly tidy-up", () => {
  /** A confirmed booking, aged, and optionally minted as seed scenery. */
  async function bookingAged(options: {
    hoursAgo: number;
    seeded: boolean;
    hour: number;
  }): Promise<string> {
    const held = await createHold(context.db, {
      businessId: context.businessId,
      staffId: context.staffA,
      serviceId: context.plainServiceId,
      startsAt: at(options.hour),
    });

    await context.db.execute(sql`
      UPDATE appointments
         SET status = 'confirmed',
             hold_expires_at = NULL,
             customer_id = ${context.customerId},
             created_at = now() - make_interval(hours => ${options.hoursAgo}::int),
             ics_uid = ${
               options.seeded
                 ? `${held.appointment.id}@${SEED_ICS_DOMAIN}`
                 : `${held.appointment.id}@openings`
             }
       WHERE id = ${held.appointment.id}
    `);

    return held.appointment.id;
  }

  it("clears a visitor's old booking and leaves the seeded diary alone", async () => {
    const old = await bookingAged({ hoursAgo: 30, seeded: false, hour: 9 });
    const fresh = await bookingAged({ hoursAgo: 2, seeded: false, hour: 11 });
    /**
     * THE ONE THAT WOULD BREAK THE DEMO.
     *
     * The seed writes a fortnight of history, all of it created before the
     * script ran. A sweep that went by age alone would delete the entire
     * demonstration on its first nightly run — so scenery is recognised by the
     * calendar domain it was minted in and skipped.
     */
    const scenery = await bookingAged({ hoursAgo: 240, seeded: true, hour: 13 });

    const cleared = await tidyDemoBookings(context.db);

    expect(cleared).toBe(1);

    const surviving = (
      await context.db.execute(sql`SELECT id FROM appointments`)
    ).rows as { id: string }[];

    const ids = surviving.map((row) => row.id);

    expect(ids).toContain(fresh);
    expect(ids).toContain(scenery);
    expect(ids).not.toContain(old);
  });

  it("never touches a business that is not a demo", async () => {
    await context.db.transaction(async (tx) => {
      await withDemoBypass(tx, async () => {
        await tx.execute(sql`
          UPDATE businesses SET is_demo = false WHERE id = ${context.businessId}
        `);
      });
    });

    await bookingAged({ hoursAgo: 300, seeded: false, hour: 9 });

    /* Scoped by a join on `is_demo`, so a real business is not one predicate
       away from having its diary swept. */
    expect(await tidyDemoBookings(context.db)).toBe(0);
  });
});
