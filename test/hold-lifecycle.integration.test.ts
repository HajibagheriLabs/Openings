import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/db/client";
import { CHECK_VIOLATION, isConstraintViolation } from "@/db/errors";
import { availabilityRules, serviceStaff } from "@/db/schema";
import {
  createHold,
  moveHold,
  readOwnHold,
  releaseHoldByToken,
  SlotTakenError,
} from "@/lib/scheduling/booking";
import { loadDayView } from "@/lib/scheduling/day-view";
import { setupTestDatabase, type TestContext } from "./helpers/database";

/**
 * The hold, end to end.
 *
 * The unit suite proves the availability arithmetic and the concurrency suite
 * proves the exclusion constraint stops two people booking one slot. What is
 * left — and what the picker's whole design rests on — is the LIFECYCLE:
 *
 *   - a hold can be taken before anybody has typed their name,
 *   - moving between two times is atomic, so a lost race leaves the customer
 *     with the slot they already had rather than with nothing,
 *   - only the browser holding the manage token can give a slot back,
 *   - a customer's own hold does not appear to them as somebody else's.
 *
 * Every one of those has a failure mode a customer would feel, and none of
 * them can be tested without a real database.
 *
 * The fixture business is Europe/Berlin. 15 September 2026 is a Tuesday, well
 * clear of any DST transition, so local time is UTC+02:00 all day.
 */

let context: TestContext;
let db: Db;

/** Weekday 2 — Tuesday, matching Postgres `extract(dow)`. */
const TUESDAY = 2;
const DATE = "2026-09-15";
const TIME_ZONE = "Europe/Berlin";

/** Well before the day under test, so the lead time is never the reason. */
const NOW = new Date("2026-09-15T05:00:00Z");

/** 09:00 local is 07:00Z; the plain service is 60 minutes with no buffers. */
const at = (hourUtc: number, minute = 0) =>
  new Date(Date.UTC(2026, 8, 15, hourUtc, minute)).toISOString();

beforeAll(async () => {
  context = await setupTestDatabase();
  db = context.db;

  await db.execute(sql`
    UPDATE businesses SET min_lead_time_min = 0 WHERE id = ${context.businessId}
  `);
});

afterAll(async () => {
  await context.pool.end();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE appointments RESTART IDENTITY CASCADE`);
  await db.delete(availabilityRules);
  await db.delete(serviceStaff);

  // Ana works Tuesdays nine to five and performs the plain 60-minute service.
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
});

function holdInput(startsAt: string, staffId = context.staffA) {
  return {
    businessId: context.businessId,
    staffId,
    serviceId: context.plainServiceId,
    startsAt,
    customerId: null,
  };
}

/**
 * Push a hold's deadline past the INJECTED clock.
 *
 * `createHold` writes `now() + 8 minutes` from the DATABASE's clock, which is
 * the real one — and these tests look at a fixed Tuesday in September 2026
 * through an injected clock, so a real deadline is already long past by the
 * time the availability query compares them. Availability would then treat the
 * hold as lapsed, which is correct behaviour and the wrong thing to be testing
 * here. Anything that needs a hold to be LIVE says so with this.
 */
async function keepAlive(appointmentId: string) {
  await db.execute(sql`
    UPDATE appointments
       SET hold_expires_at = ${new Date(NOW.getTime() + 8 * 60_000)}
     WHERE id = ${appointmentId}
  `);
}

function dayView(hold?: { appointmentId: string; startsAt: string }) {
  return loadDayView({
    db,
    businessId: context.businessId,
    serviceId: context.plainServiceId,
    staffId: "any",
    timeZone: TIME_ZONE,
    date: DATE,
    now: NOW,
    excludeAppointmentId: hold?.appointmentId,
    anchorStartsAt: hold?.startsAt,
  });
}

describe("taking a hold before there is a customer", () => {
  it("writes a held row with no customer and a database-computed deadline", async () => {
    const held = await createHold(db, holdInput(at(7)));

    expect(held.appointment.status).toBe("held");
    expect(held.appointment.customerId).toBeNull();
    expect(held.appointment.holdExpiresAt).not.toBeNull();

    // Eight minutes, give or take the round trip.
    const minutes =
      (held.appointment.holdExpiresAt!.getTime() -
        held.appointment.createdAt.getTime()) /
      60_000;

    expect(minutes).toBeGreaterThan(7.5);
    expect(minutes).toBeLessThan(8.5);
  });

  it("refuses to let an anonymous appointment be confirmed", async () => {
    const held = await createHold(db, holdInput(at(7)));

    /* The CHECK constraint from migration 0005. A hold may belong to nobody;
       anything else may not, and the database says so rather than a comment.
       Matched on SQLSTATE and the constraint NAME rather than on a message —
       Drizzle rewraps the driver error, and a message match would be one
       library upgrade from silently passing. */
    const failure: unknown = await db
      .execute(
        sql`
        UPDATE appointments SET status = 'confirmed', hold_expires_at = NULL
         WHERE id = ${held.appointment.id}
      `,
      )
      .then(() => null)
      .catch((error: unknown) => error);

    expect(
      isConstraintViolation(
        failure,
        CHECK_VIOLATION,
        "appointments_customer_required_once_booked",
      ),
    ).toBe(true);
  });

  it("blocks everybody else for as long as it lives", async () => {
    await createHold(db, holdInput(at(7)));

    await expect(createHold(db, holdInput(at(7)))).rejects.toBeInstanceOf(
      SlotTakenError,
    );
  });
});

describe("moving a hold", () => {
  it("gives the old slot back and takes the new one", async () => {
    const first = await createHold(db, holdInput(at(7)));

    const second = await moveHold(db, holdInput(at(9)), {
      appointmentId: first.appointment.id,
      manageToken: first.manageToken,
    });

    expect(second.appointment.startsAt.toISOString()).toBe(at(9));

    // Exactly one hold, not two.
    const rows = await db.execute(sql`
      SELECT count(*)::int AS total FROM appointments WHERE status = 'held'
    `);

    expect(rows.rows[0]).toEqual({ total: 1 });

    // And the old time is free again.
    const day = await dayView();
    expect(day!.starts.has(at(7))).toBe(true);
  });

  it("lets a customer shuffle WITHIN their own hold", async () => {
    /* 09:00 and 09:15 overlap on a 60-minute service, so without deleting the
       old hold first the constraint would refuse to let somebody move out of
       their own way. */
    const first = await createHold(db, holdInput(at(7)));

    const second = await moveHold(db, holdInput(at(7, 15)), {
      appointmentId: first.appointment.id,
      manageToken: first.manageToken,
    });

    expect(second.appointment.startsAt.toISOString()).toBe(at(7, 15));
  });

  it("KEEPS THE ORIGINAL SLOT when the new one is lost in a race", async () => {
    const mine = await createHold(db, holdInput(at(7)));

    // Somebody else takes 11:00 while I am looking at it.
    await createHold(db, holdInput(at(9)));

    await expect(
      moveHold(db, holdInput(at(9)), {
        appointmentId: mine.appointment.id,
        manageToken: mine.manageToken,
      }),
    ).rejects.toBeInstanceOf(SlotTakenError);

    /* THE WHOLE POINT: the transaction rolled back, so my original hold is
       still mine. Two round trips — release then create — would have left me
       with nothing at all. */
    const still = await readOwnHold(db, mine.appointment.id, mine.manageToken);

    expect(still).not.toBeNull();
    expect(still!.startsAt.toISOString()).toBe(at(7));
  });

  it("still takes the new slot when the previous hold has already gone", async () => {
    const first = await createHold(db, holdInput(at(7)));
    await releaseHoldByToken(db, first.appointment.id, first.manageToken);

    // The customer's cookie still points at a hold that no longer exists.
    const second = await moveHold(db, holdInput(at(9)), {
      appointmentId: first.appointment.id,
      manageToken: first.manageToken,
    });

    expect(second.appointment.startsAt.toISOString()).toBe(at(9));
  });
});

describe("releasing a hold", () => {
  it("gives the slot back when the token matches", async () => {
    const held = await createHold(db, holdInput(at(7)));

    expect(
      await releaseHoldByToken(db, held.appointment.id, held.manageToken),
    ).toBe(true);

    const day = await dayView();
    expect(day!.starts.has(at(7))).toBe(true);
  });

  it("refuses a wrong token, and the slot stays held", async () => {
    const held = await createHold(db, holdInput(at(7)));
    await keepAlive(held.appointment.id);

    expect(
      await releaseHoldByToken(db, held.appointment.id, "not-the-token"),
    ).toBe(false);

    const day = await dayView();
    expect(day!.starts.has(at(7))).toBe(false);
  });

  it("says false rather than throwing for a hold that is not there", async () => {
    expect(
      await releaseHoldByToken(
        db,
        "00000000-0000-0000-0000-000000000000",
        "anything",
      ),
    ).toBe(false);
  });
});

describe("reading a hold back", () => {
  it("returns it for the right token and null for the wrong one", async () => {
    const held = await createHold(db, holdInput(at(7)));

    expect(
      await readOwnHold(db, held.appointment.id, held.manageToken),
    ).not.toBeNull();

    expect(await readOwnHold(db, held.appointment.id, "wrong")).toBeNull();
  });
});

describe("the day as the holder sees it", () => {
  it("shows a stranger's hold as taken", async () => {
    const theirs = await createHold(db, holdInput(at(7)));
    await keepAlive(theirs.appointment.id);

    const day = await dayView();

    expect(day!.starts.has(at(7))).toBe(false);
    // And it is drawn as material rather than merely missing.
    expect(
      day!.view.blocks.some(
        (block) => block.kind === "busy" && block.startsAt === at(7),
      ),
    ).toBe(true);
  });

  it("shows the holder their OWN slot as still offerable", async () => {
    const held = await createHold(db, holdInput(at(7)));
    await keepAlive(held.appointment.id);

    const day = await dayView({
      appointmentId: held.appointment.id,
      startsAt: at(7),
    });

    /* Without the exclusion, the customer would watch the slot they had just
       taken redraw as taken by somebody else. */
    expect(day!.starts.has(at(7))).toBe(true);
    expect(day!.view.offers.some((offer) => offer.startsAt === at(7))).toBe(
      true,
    );
    expect(
      day!.view.blocks.some((block) => block.startsAt === at(7)),
    ).toBe(false);
  });

  it("stops blocking once the deadline has passed, without anything sweeping it", async () => {
    const held = await createHold(db, holdInput(at(7)));
    await keepAlive(held.appointment.id);

    // Confirm it really was blocking before the deadline moved.
    const before = await dayView();
    expect(before!.starts.has(at(7))).toBe(false);

    await db.execute(sql`
      UPDATE appointments SET hold_expires_at = now() - interval '1 minute'
       WHERE id = ${held.appointment.id}
    `);

    /* EXPIRY IS LAZY. The row is still there and the constraint still covers
       it, but availability treats a lapsed hold as free — which is what makes
       the janitor housekeeping rather than a safety mechanism. */
    const day = await dayView();

    expect(day!.starts.has(at(7))).toBe(true);
  });

  it("draws the day's shape, not just its openings", async () => {
    const theirs = await createHold(db, holdInput(at(9)));
    await keepAlive(theirs.appointment.id);

    const day = await dayView();

    expect(day!.view.closed).toBe(false);
    // Nine to five, rounded out to whole hours: 540 → 1020 local minutes.
    expect(day!.view.window).toEqual({ startMinute: 540, endMinute: 1020 });
    expect(day!.view.blocks.length).toBeGreaterThan(0);
    expect(day!.view.offers.length).toBeGreaterThan(0);
    // Every drawn offer is a start the policy actually allows.
    for (const offer of day!.view.offers) {
      expect(day!.starts.has(offer.startsAt)).toBe(true);
    }
  });

  it("reports a day with no hours as closed", async () => {
    await db.delete(availabilityRules);

    const day = await dayView();

    expect(day!.view.closed).toBe(true);
    expect(day!.view.offers).toEqual([]);
  });
});
