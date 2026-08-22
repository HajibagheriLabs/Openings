import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/db/client";
import { availabilityRules, customers, notifications, serviceStaff } from "@/db/schema";
import { MAX_UPCOMING_PER_EMAIL } from "@/lib/booking/policy";
import { claimHold, createHold } from "@/lib/scheduling/booking";
import {
  checkLeadTime,
  checkMaxAdvance,
  checkRateLimit,
  findOverlappingConfirmed,
} from "@/server/booking/policy";
import { setupTestDatabase, type TestContext } from "./helpers/database";

/**
 * The policy layer, and the free-consultation path.
 *
 * Every check here has a failure mode a customer would feel: a booking made
 * inside the lead time the business advertises, a second appointment created
 * because somebody pressed the button twice, one visitor quietly sitting on a
 * whole afternoon, and — the one that is nobody's edge case — a business that
 * takes no deposit being sent to a payment page for nought pounds.
 *
 * The fixture business is Europe/Berlin. 15 September 2026 is a Tuesday, clear
 * of any DST transition, so local time is UTC+02:00 all day.
 */

let context: TestContext;
let db: Db;

/** Weekday 2 — Tuesday, matching Postgres `extract(dow)`. */
const TUESDAY = 2;
const TIME_ZONE = "Europe/Berlin";
const NOW = new Date("2026-09-15T05:00:00Z");

/** 09:00 local is 07:00Z; the plain service is 60 minutes with no buffers. */
const at = (hourUtc: number, minute = 0) =>
  new Date(Date.UTC(2026, 8, 15, hourUtc, minute));

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
  await db.delete(customers);
  await db.delete(availabilityRules);
  await db.delete(serviceStaff);

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

function hold(startsAt: Date) {
  return createHold(db, {
    businessId: context.businessId,
    staffId: context.staffA,
    serviceId: context.plainServiceId,
    startsAt,
    customerId: null,
  });
}

/* ===========================================================================
   The checks that need no database
   =========================================================================== */

describe("lead time", () => {
  it("passes when the appointment is beyond the notice period", () => {
    expect(checkLeadTime(at(10), 120, NOW)).toBeNull();
  });

  it("REFUSES A SLOT THAT WENT INSIDE THE WINDOW WHILE THE FORM WAS OPEN", () => {
    /* The slot was legitimately offered when the day was drawn. Five minutes
       of typing later it is inside the two hours the business asks for, and
       this is the only place that can catch it. */
    const refusal = checkLeadTime(at(6), 120, NOW);

    expect(refusal?.code).toBe("too-soon");
    expect(refusal?.message).toContain("2 hours");
  });

  it("says the notice period in words a person uses", () => {
    expect(checkLeadTime(at(5, 10), 45, NOW)?.message).toContain("45 minutes");
    expect(checkLeadTime(at(5, 10), 60, NOW)?.message).toContain("an hour");
  });

  it("still refuses a time that has simply passed, with no notice period", () => {
    expect(checkLeadTime(at(4), 0, NOW)?.code).toBe("too-soon");
  });
});

describe("the booking horizon", () => {
  it("allows the last day the calendar offers", () => {
    /* 60 days from 15 September is 14 November, inclusive — so anything on the
       14th is in and the 15th is out. The calendar reads it the same way; if
       these two ever disagree a customer fills in a form for a slot that is
       then refused. */
    expect(
      checkMaxAdvance(new Date("2026-11-14T10:00:00Z"), 60, TIME_ZONE, NOW),
    ).toBeNull();
  });

  it("refuses the day after it", () => {
    const refusal = checkMaxAdvance(
      new Date("2026-11-15T10:00:00Z"),
      60,
      TIME_ZONE,
      NOW,
    );

    expect(refusal?.code).toBe("too-far");
    expect(refusal?.message).toContain("60 days");
  });
});

/* ===========================================================================
   The checks that do
   =========================================================================== */

describe("one person, one appointment at a time", () => {
  async function confirmFor(email: string, startsAt: Date) {
    const held = await hold(startsAt);

    const claimed = await claimHold(db, {
      appointmentId: held.appointment.id,
      manageToken: held.manageToken,
      businessId: context.businessId,
      customer: { name: "Sam Taylor", email, phone: null },
      customerNote: null,
      policyAcceptedAt: NOW,
      confirmNow: true,
    });

    expect(claimed.ok).toBe(true);

    return held;
  }

  it("says nothing when the email is new here", async () => {
    const held = await hold(at(7));

    expect(
      await findOverlappingConfirmed(db, {
        businessId: context.businessId,
        email: "new@example.test",
        startsAt: held.appointment.startsAt,
        endsAt: held.appointment.endsAt,
        excludeAppointmentId: held.appointment.id,
      }),
    ).toBeNull();
  });

  it("FINDS THE ONE THEY ALREADY HAVE across the same hour", async () => {
    await confirmFor("sam@example.test", at(7));

    const second = await hold(at(9));

    const refusal = await findOverlappingConfirmed(db, {
      businessId: context.businessId,
      email: "sam@example.test",
      /* Pretend the second hold runs across the first — the check is about the
         customer-facing span, not about which row it came from. */
      startsAt: at(7, 30),
      endsAt: at(8, 30),
      excludeAppointmentId: second.appointment.id,
    });

    expect(refusal?.code).toBe("duplicate");
    expect(refusal?.existing?.serviceName).toBe("Consultation");
    /* No link is offered: this browser has proved nothing about owning that
       appointment, so the way in is the confirmation email. */
    expect(refusal?.message).toContain("confirmation email");
  });

  it("does not mind an appointment at a different time", async () => {
    await confirmFor("sam@example.test", at(7));

    const second = await hold(at(9));

    expect(
      await findOverlappingConfirmed(db, {
        businessId: context.businessId,
        email: "sam@example.test",
        startsAt: second.appointment.startsAt,
        endsAt: second.appointment.endsAt,
        excludeAppointmentId: second.appointment.id,
      }),
    ).toBeNull();
  });

  it("never counts the hold being claimed against itself", async () => {
    const held = await hold(at(7));

    await claimHold(db, {
      appointmentId: held.appointment.id,
      manageToken: held.manageToken,
      businessId: context.businessId,
      customer: { name: "Sam", email: "sam@example.test", phone: null },
      customerNote: null,
      policyAcceptedAt: NOW,
      confirmNow: true,
    });

    // Re-running the check on the very appointment it just created must pass.
    expect(
      await findOverlappingConfirmed(db, {
        businessId: context.businessId,
        email: "sam@example.test",
        startsAt: held.appointment.startsAt,
        endsAt: held.appointment.endsAt,
        excludeAppointmentId: held.appointment.id,
      }),
    ).toBeNull();
  });
});

describe("how much of the calendar one email may sit on", () => {
  it("allows an ordinary customer through", async () => {
    const held = await hold(at(7));

    expect(
      await checkRateLimit(db, {
        businessId: context.businessId,
        email: "sam@example.test",
        now: NOW,
        excludeAppointmentId: held.appointment.id,
      }),
    ).toBeNull();
  });

  it("REFUSES ONCE THEY ARE HOLDING THE CAP", async () => {
    /* One visitor with a stack of private windows is the case this exists for:
       each window has its own cookie and so its own hold, and the email is the
       only thing that is the same across all of them. */
    for (let index = 0; index < MAX_UPCOMING_PER_EMAIL; index += 1) {
      const held = await hold(at(7 + index * 2));

      await claimHold(db, {
        appointmentId: held.appointment.id,
        manageToken: held.manageToken,
        businessId: context.businessId,
        customer: { name: "Sam", email: "sam@example.test", phone: null },
        customerNote: null,
        policyAcceptedAt: NOW,
        confirmNow: true,
      });
    }

    const next = await hold(at(13));

    const refusal = await checkRateLimit(db, {
      businessId: context.businessId,
      email: "sam@example.test",
      now: new Date("2026-09-15T04:00:00Z"),
      excludeAppointmentId: next.appointment.id,
    });

    expect(refusal?.code).toBe("rate-limited");
    expect(refusal?.message).toContain("already have");
  });

  it("scopes the count to one business", async () => {
    const held = await hold(at(7));

    await claimHold(db, {
      appointmentId: held.appointment.id,
      manageToken: held.manageToken,
      businessId: context.businessId,
      customer: { name: "Sam", email: "sam@example.test", phone: null },
      customerNote: null,
      policyAcceptedAt: NOW,
      confirmNow: true,
    });

    /* A customer with appointments at their dentist has said nothing at all
       about their hairdresser. */
    const next = await hold(at(9));

    expect(
      await checkRateLimit(db, {
        businessId: "00000000-0000-0000-0000-000000000000",
        email: "sam@example.test",
        now: NOW,
        excludeAppointmentId: next.appointment.id,
      }),
    ).toBeNull();
  });
});

/* ===========================================================================
   Claiming — the customer record, and the free-consultation path
   =========================================================================== */

describe("claiming a hold", () => {
  it("CONFIRMS THERE AND THEN WHEN NOTHING IS OWED", async () => {
    const held = await hold(at(7));

    const claimed = await claimHold(db, {
      appointmentId: held.appointment.id,
      manageToken: held.manageToken,
      businessId: context.businessId,
      customer: {
        name: "Sam Taylor",
        email: "sam@example.test",
        phone: "07700 900123",
      },
      customerNote: "Wheelchair access, please.",
      policyAcceptedAt: NOW,
      confirmNow: true,
    });

    expect(claimed.ok).toBe(true);

    if (!claimed.ok) {
      return;
    }

    expect(claimed.appointment.status).toBe("confirmed");
    expect(claimed.appointment.holdExpiresAt).toBeNull();
    expect(claimed.appointment.customerId).toBe(claimed.customerId);
    expect(claimed.appointment.customerNote).toBe("Wheelchair access, please.");
    expect(claimed.appointment.policyAcceptedAt).not.toBeNull();

    /* The confirmation email is a ROW, not a send. A Resend outage must not be
       able to roll back a confirmed appointment. */
    const queued = await db.select().from(notifications);

    expect(queued).toHaveLength(1);
    expect(queued[0].kind).toBe("confirmation");
    expect(queued[0].toEmail).toBe("sam@example.test");
    expect(queued[0].status).toBe("pending");
  });

  it("leaves the appointment held when a deposit is due", async () => {
    const held = await hold(at(7));

    const claimed = await claimHold(db, {
      appointmentId: held.appointment.id,
      manageToken: held.manageToken,
      businessId: context.businessId,
      customer: { name: "Sam", email: "sam@example.test", phone: null },
      customerNote: null,
      policyAcceptedAt: NOW,
      confirmNow: false,
    });

    expect(claimed.ok).toBe(true);

    if (!claimed.ok) {
      return;
    }

    /* The slot stays reserved and the countdown keeps running — confirmation
       happens only in the verified Stripe webhook, never before payment. */
    expect(claimed.appointment.status).toBe("held");
    expect(claimed.appointment.holdExpiresAt).not.toBeNull();
    expect(claimed.appointment.customerId).not.toBeNull();

    // And nothing is queued to say it is confirmed, because it is not.
    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it("NEVER CREATES A SECOND CUSTOMER FOR THE SAME EMAIL", async () => {
    const first = await hold(at(7));

    await claimHold(db, {
      appointmentId: first.appointment.id,
      manageToken: first.manageToken,
      businessId: context.businessId,
      customer: { name: "Sam Tayor", email: "sam@example.test", phone: null },
      customerNote: null,
      policyAcceptedAt: NOW,
      confirmNow: true,
    });

    const second = await hold(at(9));

    const claimed = await claimHold(db, {
      appointmentId: second.appointment.id,
      manageToken: second.manageToken,
      businessId: context.businessId,
      // Typo fixed, and a number given this time.
      customer: {
        name: "Sam Taylor",
        email: "sam@example.test",
        phone: "07700 900123",
      },
      customerNote: null,
      policyAcceptedAt: NOW,
      confirmNow: true,
    });

    expect(claimed.ok).toBe(true);

    const rows = await db.select().from(customers);

    expect(rows).toHaveLength(1);
    // The name they just typed wins: they know it better than the old row.
    expect(rows[0].name).toBe("Sam Taylor");
    expect(rows[0].phone).toBe("07700 900123");
  });

  it("does not wipe a stored phone when the field is left blank", async () => {
    const first = await hold(at(7));

    await claimHold(db, {
      appointmentId: first.appointment.id,
      manageToken: first.manageToken,
      businessId: context.businessId,
      customer: {
        name: "Sam",
        email: "sam@example.test",
        phone: "07700 900123",
      },
      customerNote: null,
      policyAcceptedAt: NOW,
      confirmNow: true,
    });

    const second = await hold(at(9));

    await claimHold(db, {
      appointmentId: second.appointment.id,
      manageToken: second.manageToken,
      businessId: context.businessId,
      customer: { name: "Sam", email: "sam@example.test", phone: null },
      customerNote: null,
      policyAcceptedAt: NOW,
      confirmNow: true,
    });

    const [row] = await db.select().from(customers);

    /* Leaving the optional field blank is not the same as asking us to forget
       the number they gave last time. */
    expect(row.phone).toBe("07700 900123");
  });

  it("refuses a token that is not theirs, and changes nothing", async () => {
    const held = await hold(at(7));

    const claimed = await claimHold(db, {
      appointmentId: held.appointment.id,
      manageToken: "not-the-token",
      businessId: context.businessId,
      customer: { name: "Mallory", email: "mallory@example.test", phone: null },
      customerNote: null,
      policyAcceptedAt: NOW,
      confirmNow: true,
    });

    expect(claimed).toEqual({ ok: false, reason: "hold-gone" });
    // The whole transaction rolled back — no customer, no claim.
    expect(await db.select().from(customers)).toHaveLength(0);
  });

  it("says the hold is gone when it has already been swept", async () => {
    const held = await hold(at(7));

    await db.execute(sql`
      DELETE FROM appointments WHERE id = ${held.appointment.id}
    `);

    expect(
      await claimHold(db, {
        appointmentId: held.appointment.id,
        manageToken: held.manageToken,
        businessId: context.businessId,
        customer: { name: "Sam", email: "sam@example.test", phone: null },
        customerNote: null,
        policyAcceptedAt: NOW,
        confirmNow: true,
      }),
    ).toEqual({ ok: false, reason: "hold-gone" });
  });
});
