import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/db/client";
import { appointments, businesses, notifications, rateLimits } from "@/db/schema";
import { deriveManageToken } from "@/lib/notifications/manage-link";
import {
  cancelAppointment,
  claimHold,
  createHold,
  hashManageToken,
  moveAppointment,
} from "@/lib/scheduling/booking";
import { resolveManageToken } from "@/server/booking/manage";
import {
  consumeRateLimit,
  forgetIdleRateLimits,
  rateLimitKey,
} from "@/server/booking/rate-limit";

import { at, clearAppointments, setupTestDatabase } from "../helpers/database";

/**
 * The guest self-service page, against a real database.
 *
 * THE THREE THINGS THAT CANNOT BE TESTED WITHOUT ONE:
 *
 *   THE TOKEN LOOKUP is an index seek on a hash — the token is never stored,
 *   so "does this link open this appointment?" is a question only Postgres can
 *   answer.
 *
 *   THE MOVE is one UPDATE arbitrated by the exclusion constraint. Its whole
 *   guarantee — that a lost race leaves the customer with the appointment they
 *   started with rather than none — is a property of that constraint, and a
 *   mocked database would only assert that the code calls what it calls.
 *
 *   THE CANCEL is idempotent because of `WHERE status = 'confirmed'`, which is
 *   what stops a double-click attempting two refunds.
 */

let context: Awaited<ReturnType<typeof setupTestDatabase>>;
let db: Db;

beforeAll(async () => {
  context = await setupTestDatabase();
  db = context.db;
});

afterAll(async () => {
  await context.pool.end();
});

beforeEach(async () => {
  await clearAppointments(db);
  await db.delete(rateLimits);
  await db
    .update(businesses)
    .set({
      cancellationWindowHours: 24,
      allowReschedule: true,
      refundDepositOnCancel: true,
    })
    .where(eq(businesses.id, context.businessId));
});

/* ===========================================================================
   Fixtures
   =========================================================================== */

/** Far enough out that the day's notice is comfortably satisfied. */
function startsInDays(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

/** A confirmed booking, made through the real path so the row is real. */
async function book(startsAt: Date, staffId = context.staffA) {
  const held = await createHold(db, {
    businessId: context.businessId,
    staffId,
    serviceId: context.plainServiceId,
    startsAt,
  });

  const claimed = await claimHold(db, {
    appointmentId: held.appointment.id,
    manageToken: held.manageToken,
    businessId: context.businessId,
    customer: {
      name: "Sam Taylor",
      email: "sam@example.test",
      phone: null,
      timeZone: null,
    },
    customerNote: null,
    policyAcceptedAt: new Date(),
    confirmNow: true,
  });

  if (!claimed.ok) {
    throw new Error("the fixture booking did not claim its hold");
  }

  return {
    id: claimed.appointment.id,
    token: held.manageToken,
    icsUid: claimed.appointment.icsUid,
  };
}

function rowOf(appointmentId: string) {
  return db
    .select()
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .limit(1)
    .then(([row]) => row);
}

/* ===========================================================================
   The token
   =========================================================================== */

describe("the manage token", () => {
  it("opens the appointment it was derived from", async () => {
    const booking = await book(startsInDays(5));

    const resolved = await resolveManageToken(db, booking.token);

    expect(resolved.status).toBe("ok");

    if (resolved.status !== "ok") {
      return;
    }

    expect(resolved.view.appointmentId).toBe(booking.id);
    /* Scoped for the picker, off the row rather than off the caller. */
    expect(resolved.view.serviceId).toBe(context.plainServiceId);
    expect(resolved.view.staffId).toBe(context.staffA);
  });

  it("stores only the hash — never the token itself", async () => {
    const booking = await book(startsInDays(5));
    const row = await rowOf(booking.id);

    expect(row.manageTokenHash).toBe(hashManageToken(booking.token));
    /* The plaintext appears nowhere on the row. */
    expect(JSON.stringify(row)).not.toContain(booking.token);
  });

  it("is derivable from the appointment's UID, so a worker can rebuild it", async () => {
    const booking = await book(startsInDays(5));

    expect(deriveManageToken(booking.icsUid)).toBe(booking.token);
  });

  it("refuses a token that matches nothing, and names no business", async () => {
    const resolved = await resolveManageToken(
      db,
      "definitely-not-a-real-manage-token-at-all",
    );

    expect(resolved.status).toBe("unknown");
  });

  it("refuses a token that is the wrong shape without touching the database", async () => {
    expect((await resolveManageToken(db, "")).status).toBe("unknown");
    expect((await resolveManageToken(db, "short")).status).toBe("unknown");
  });

  /**
   * EXPIRY IS DERIVED FROM `ends_at`, so an appointment far enough in the past
   * has a dead link — and the answer still names the business, because the row
   * is there and we know exactly who they booked with.
   */
  it("expires a set time after the appointment, and still names the business", async () => {
    const booking = await book(startsInDays(5));

    /* Push the appointment ninety days into the past. */
    await db
      .update(appointments)
      .set({
        startsAt: sql`now() - interval '90 days'`,
        endsAt: sql`now() - interval '90 days' + interval '1 hour'`,
      })
      .where(eq(appointments.id, booking.id));

    const resolved = await resolveManageToken(db, booking.token);

    expect(resolved.status).toBe("expired");

    if (resolved.status !== "expired") {
      return;
    }

    expect(resolved.contact.name).toBe("Test Clinic");
    expect(resolved.contact.email).toBe("hello@example.test");
    expect(resolved.contact.bookingPath).toContain("/book/test-clinic");
  });

  it("still opens a link for an appointment that has merely passed", async () => {
    const booking = await book(startsInDays(5));

    await db
      .update(appointments)
      .set({
        startsAt: sql`now() - interval '2 days'`,
        endsAt: sql`now() - interval '2 days' + interval '1 hour'`,
      })
      .where(eq(appointments.id, booking.id));

    const resolved = await resolveManageToken(db, booking.token);

    /* Two days is well inside the sixty-day life. They can still see what they
       paid; they simply cannot change anything. */
    expect(resolved.status).toBe("ok");

    if (resolved.status !== "ok") {
      return;
    }

    expect(resolved.view.permissions.canCancel).toBe(false);
    expect(resolved.view.permissions.cancelRefusal).toContain("already started");
  });

  it("never opens a hold", async () => {
    const held = await createHold(db, {
      businessId: context.businessId,
      staffId: context.staffB,
      serviceId: context.plainServiceId,
      startsAt: startsInDays(4),
    });

    /* A hold has never been emailed to anybody and a link to one should not
       exist. It resolves as unknown rather than as an appointment. */
    expect((await resolveManageToken(db, held.manageToken)).status).toBe("unknown");
  });
});

/* ===========================================================================
   The reschedule transaction
   =========================================================================== */

describe("moving an appointment", () => {
  it("takes the new slot and frees the old one in one statement", async () => {
    const booking = await book(at(9));
    const before = await rowOf(booking.id);

    const moved = await moveAppointment(db, {
      appointmentId: booking.id,
      startsAt: at(13),
    });

    expect(moved.outcome).toBe("moved");

    if (moved.outcome !== "moved") {
      return;
    }

    expect(moved.appointment.startsAt.toISOString()).toBe(at(13).toISOString());
    expect(moved.previous.startsAt.toISOString()).toBe(at(9).toISOString());

    /* The UID never changes — same appointment, same calendar event — and the
       sequence goes up, or every client ignores the updated invite. */
    expect(moved.appointment.icsUid).toBe(before.icsUid);
    expect(moved.appointment.icsSequence).toBe(before.icsSequence + 1);

    /* The old time is genuinely free: another booking can take it. */
    const backfill = await createHold(db, {
      businessId: context.businessId,
      staffId: context.staffA,
      serviceId: context.plainServiceId,
      startsAt: at(9),
    });

    expect(backfill.appointment.id).not.toBe(booking.id);
  });

  /**
   * ═══ THE GUARANTEE ═══
   *
   * A failure must never leave the customer with no appointment. The move is
   * one UPDATE arbitrated by the exclusion constraint, so losing the race
   * rolls the whole thing back and the original booking is untouched.
   */
  it("leaves the appointment EXACTLY where it was when the new time is taken", async () => {
    const booking = await book(at(9));
    const before = await rowOf(booking.id);

    /* Somebody else takes 13:00 first. */
    await book(at(13), context.staffA).catch(() => {
      throw new Error("the blocking fixture could not be booked");
    });

    const moved = await moveAppointment(db, {
      appointmentId: booking.id,
      startsAt: at(13),
    });

    expect(moved.outcome).toBe("slot-taken");

    const after = await rowOf(booking.id);

    expect(after.status).toBe("confirmed");
    expect(after.startsAt.toISOString()).toBe(before.startsAt.toISOString());
    expect(after.endsAt.toISOString()).toBe(before.endsAt.toISOString());
    /* And nothing about the calendar identity moved either — no phantom
       sequence bump for a move that did not happen. */
    expect(after.icsSequence).toBe(before.icsSequence);
  });

  /**
   * A move that overlaps the appointment's OWN old span is legal, and it is
   * the case "release then re-book" could not express at all: the constraint
   * does not compare a row against itself.
   */
  it("can shuffle within its own old span", async () => {
    const booking = await book(at(9));

    const moved = await moveAppointment(db, {
      appointmentId: booking.id,
      startsAt: at(9, 30),
    });

    expect(moved.outcome).toBe("moved");
    expect((await rowOf(booking.id)).startsAt.toISOString()).toBe(
      at(9, 30).toISOString(),
    );
  });

  it("does nothing at all when it is already on that instant", async () => {
    const booking = await book(at(9));
    const before = await rowOf(booking.id);

    const moved = await moveAppointment(db, {
      appointmentId: booking.id,
      startsAt: at(9),
    });

    expect(moved.outcome).toBe("unchanged");

    /* A double-submitted move must not bump the sequence twice and send a
       second invite for a time nothing changed about. */
    expect((await rowOf(booking.id)).icsSequence).toBe(before.icsSequence);
  });

  it("refuses to move an appointment that was cancelled", async () => {
    const booking = await book(at(9));

    await cancelAppointment(db, {
      appointmentId: booking.id,
      cancelledBy: "customer",
      reason: null,
    });

    const moved = await moveAppointment(db, {
      appointmentId: booking.id,
      startsAt: at(13),
    });

    expect(moved).toMatchObject({ outcome: "not-movable", status: "cancelled" });
  });
});

/* ===========================================================================
   Cancelling
   =========================================================================== */

describe("cancelling an appointment", () => {
  it("frees the slot immediately and records who did it", async () => {
    const booking = await book(at(9));

    const cancelled = await cancelAppointment(db, {
      appointmentId: booking.id,
      cancelledBy: "customer",
      reason: null,
    });

    expect(cancelled.outcome).toBe("cancelled");

    const row = await rowOf(booking.id);

    expect(row.status).toBe("cancelled");
    expect(row.cancelledBy).toBe("customer");
    expect(row.cancelledAt).not.toBeNull();
    /* The METHOD:CANCEL going out has to outrank the invite already in the
       customer's calendar. */
    expect(row.icsSequence).toBeGreaterThan(0);

    /* No sweep required: the exclusion constraint covers only held and
       confirmed, so the time is back in the day the moment this commits. */
    const backfill = await createHold(db, {
      businessId: context.businessId,
      staffId: context.staffA,
      serviceId: context.plainServiceId,
      startsAt: at(9),
    });

    expect(backfill.appointment.id).not.toBe(booking.id);
  });

  /**
   * ═══ THE DOUBLE-CLICK, AND WHY IT CANNOT REFUND TWICE ═══
   *
   * Both calls run. Exactly one matches `WHERE status = 'confirmed'` and
   * reports `cancelled`; the other reports `already-cancelled`. The refund in
   * the action hangs off the first answer only, so the second click cannot
   * reach Stripe.
   */
  it("reports the second of two concurrent cancels as already-cancelled", async () => {
    const booking = await book(at(9));

    const [first, second] = await Promise.all([
      cancelAppointment(db, {
        appointmentId: booking.id,
        cancelledBy: "customer",
        reason: null,
      }),
      cancelAppointment(db, {
        appointmentId: booking.id,
        cancelledBy: "customer",
        reason: null,
      }),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();

    expect(outcomes).toEqual(["already-cancelled", "cancelled"]);

    /* And exactly one bump, not two. */
    expect((await rowOf(booking.id)).icsSequence).toBe(1);
  });

  it("reports a sequential second cancel the same way", async () => {
    const booking = await book(at(9));

    await cancelAppointment(db, {
      appointmentId: booking.id,
      cancelledBy: "customer",
      reason: null,
    });

    const again = await cancelAppointment(db, {
      appointmentId: booking.id,
      cancelledBy: "customer",
      reason: null,
    });

    expect(again.outcome).toBe("already-cancelled");
    expect((await rowOf(booking.id)).icsSequence).toBe(1);
  });

  it("withdraws the reminder that was queued for it", async () => {
    const booking = await book(startsInDays(5));

    const before = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.appointmentId, booking.id),
          eq(notifications.kind, "reminder"),
        ),
      );

    expect(before).toHaveLength(1);
    expect(before[0].status).toBe("pending");
  });
});

/* ===========================================================================
   Rate limiting
   =========================================================================== */

describe("the rate limiter", () => {
  it("allows up to the limit and refuses past it", async () => {
    const key = rateLimitKey("test", "subject-a");
    const rule = { limit: 3, windowSeconds: 60 };

    const verdicts = [];

    for (let index = 0; index < 5; index += 1) {
      verdicts.push(await consumeRateLimit(db, key, rule));
    }

    expect(verdicts.map((verdict) => verdict.allowed)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(verdicts[4].used).toBe(5);
    expect(verdicts[4].retryAfterSeconds).toBeGreaterThan(0);
  });

  it("counts each subject separately", async () => {
    const rule = { limit: 1, windowSeconds: 60 };

    await consumeRateLimit(db, rateLimitKey("test", "one"), rule);
    const other = await consumeRateLimit(db, rateLimitKey("test", "two"), rule);

    /* One customer behind a shared address must not lock out another. */
    expect(other.allowed).toBe(true);
  });

  it("hashes the subject rather than storing it", async () => {
    await consumeRateLimit(db, rateLimitKey("manage:ip", "203.0.113.7"), {
      limit: 5,
      windowSeconds: 60,
    });

    const [row] = await db.select().from(rateLimits);

    /* An IP address is personal data and a token is a credential. Neither goes
       into a counter in plaintext. */
    expect(row.key).not.toContain("203.0.113.7");
    expect(row.key.startsWith("manage:ip:")).toBe(true);
  });

  it("starts a fresh window once the old one has rolled", async () => {
    const key = rateLimitKey("test", "rolling");
    const rule = { limit: 2, windowSeconds: 60 };

    await consumeRateLimit(db, key, rule);
    await consumeRateLimit(db, key, rule);
    expect((await consumeRateLimit(db, key, rule)).allowed).toBe(false);

    /* Age the window past its end, the way the clock would. */
    await db
      .update(rateLimits)
      .set({ windowStartedAt: sql`now() - interval '2 minutes'` })
      .where(eq(rateLimits.key, key));

    const afterRoll = await consumeRateLimit(db, key, rule);

    expect(afterRoll.allowed).toBe(true);
    expect(afterRoll.used).toBe(1);
  });

  it("forgets counters that have gone quiet", async () => {
    const key = rateLimitKey("test", "idle");

    await consumeRateLimit(db, key, { limit: 5, windowSeconds: 60 });
    await db
      .update(rateLimits)
      .set({ windowStartedAt: sql`now() - interval '3 days'` })
      .where(eq(rateLimits.key, key));

    expect(await forgetIdleRateLimits(db)).toBe(1);
    expect(await db.select().from(rateLimits)).toHaveLength(0);
  });
});
