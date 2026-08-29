import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/db/client";
import { appointments, businesses, notifications } from "@/db/schema";
import {
  cancelScheduledDeliveries,
  dispatchDeliveries,
  countScheduled,
  countUnscheduled,
  rescheduleReminder,
} from "@/lib/notifications/delivery";
import type { Mailer, OutboundEmail } from "@/lib/notifications/mailer";
import type { ScheduleOutcome, Scheduler } from "@/lib/notifications/scheduler";
import { drainNotifications } from "@/lib/notifications/worker";
import { claimHold, createHold } from "@/lib/scheduling/booking";

import { clearAppointments, setupTestDatabase } from "../helpers/database";

/**
 * Scheduled delivery, end to end, against a real database.
 *
 * THE MODEL BEING TESTED, in one sentence: a reminder is queued by the booking
 * transaction and handed to a delivery service for its exact minute, the
 * service's message id is stored so the appointment moving or being cancelled
 * can call it off, and a daily sweep catches anything left behind.
 *
 * The database is real because every interesting part of that is a row: the
 * message id, the `cancelled` status, the claim lease. The delivery service is
 * a fake, because it is the boundary that leaves the machine — and because a
 * test that published real QStash messages would schedule real HTTP callbacks
 * against a machine that is not listening.
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
  await db
    .update(businesses)
    .set({ reminderLeadMin: 24 * 60 })
    .where(eq(businesses.id, context.businessId));
});

/* ===========================================================================
   Doubles
   =========================================================================== */

/** Records everything published and cancelled. `refuse` simulates an outage. */
function fakeScheduler(
  options: { configured?: boolean; refuse?: boolean; uncancellable?: boolean } = {},
) {
  const published: { notificationId: string; deliverAt: Date }[] = [];
  const cancelled: string[] = [];
  let next = 0;

  const scheduler: Scheduler = {
    name: options.configured === false ? "cron-only" : "fake",
    configured: options.configured !== false,

    async schedule(input): Promise<ScheduleOutcome> {
      if (options.refuse) {
        return { status: "failed", reason: "the service is unreachable" };
      }

      published.push(input);
      next += 1;

      return { status: "scheduled", messageId: `msg_${next}` };
    },

    async cancel(messageId) {
      cancelled.push(messageId);

      return !options.uncancellable;
    },
  };

  return { scheduler, published, cancelled };
}

function spyMailer() {
  const sent: OutboundEmail[] = [];

  const mailer: Mailer = {
    name: "spy",
    async send(email) {
      sent.push(email);
    },
  };

  return { mailer, sent };
}

/* ===========================================================================
   Fixtures
   =========================================================================== */

/** Far enough out that a day's reminder lead still lands in the future. */
function startsInDays(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

/**
 * A confirmed, free booking, made through the real path.
 *
 * `claimHold` with `confirmNow` is what a no-deposit booking does, and it is
 * the transaction that writes the outbox rows — including the reminder, at
 * whatever lead time the business is set to. Building the rows by hand would
 * test the test.
 */
async function bookFreely(startsAt: Date, staffId = context.staffA) {
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

  return claimed.appointment.id;
}

function rowsFor(appointmentId: string) {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.appointmentId, appointmentId));
}

async function reminderFor(appointmentId: string) {
  const [row] = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.appointmentId, appointmentId),
        eq(notifications.kind, "reminder"),
      ),
    )
    .limit(1);

  return row;
}

/* ===========================================================================
   Queueing
   =========================================================================== */

describe("what a booking queues", () => {
  it("counts the reminder back from the business's lead time", async () => {
    await db
      .update(businesses)
      .set({ reminderLeadMin: 120 })
      .where(eq(businesses.id, context.businessId));

    const startsAt = startsInDays(3);
    const appointmentId = await bookFreely(startsAt);

    const reminder = await reminderFor(appointmentId);

    /* Two hours before, to the second — the setting, not the old constant. */
    expect(reminder.scheduledFor.getTime()).toBe(
      startsAt.getTime() - 120 * 60_000,
    );
  });

  /**
   * A booking made inside the reminder window has no reminder to give. The row
   * is never written, so nothing can later decide it is overdue and deliver a
   * "your appointment is tomorrow" email about an appointment this afternoon.
   */
  it("queues NO reminder for a booking made inside the window", async () => {
    const appointmentId = await bookFreely(
      new Date(Date.now() + 3 * 60 * 60 * 1000),
    );

    const kinds = (await rowsFor(appointmentId)).map((row) => row.kind).sort();

    expect(kinds).toEqual(["confirmation", "new_booking"]);
    expect(await reminderFor(appointmentId)).toBeUndefined();
  });
});

/* ===========================================================================
   Dispatch
   =========================================================================== */

describe("dispatching a confirmed booking", () => {
  it("schedules every queued message and stores the message id", async () => {
    const startsAt = startsInDays(5);
    const appointmentId = await bookFreely(startsAt);
    const { scheduler, published } = fakeScheduler();

    const result = await dispatchDeliveries(db, appointmentId, { scheduler });

    expect(result).toMatchObject({ scheduler: "fake", scheduled: 3, failed: 0 });

    /* The reminder is published for its own instant; the two immediate
       messages for now. */
    const reminder = await reminderFor(appointmentId);
    const forReminder = published.find(
      (message) => message.notificationId === reminder.id,
    );

    expect(forReminder?.deliverAt.getTime()).toBe(
      startsAt.getTime() - 24 * 60 * 60_000,
    );

    /* THE HANDLE. Without it, moving or cancelling this appointment could not
       call the delivery off. */
    expect(reminder.schedulerMessageId).toMatch(/^msg_/);

    for (const row of await rowsFor(appointmentId)) {
      expect(row.schedulerMessageId, row.kind).not.toBeNull();
    }
  });

  it("does not publish twice when the webhook is retried", async () => {
    const appointmentId = await bookFreely(startsInDays(5));
    const { scheduler, published } = fakeScheduler();

    await dispatchDeliveries(db, appointmentId, { scheduler });
    const second = await dispatchDeliveries(db, appointmentId, { scheduler });

    expect(second.scheduled).toBe(0);
    expect(published).toHaveLength(3);
  });

  /**
   * THE FALLBACK, AND IT IS A FIRST-CLASS PATH.
   *
   * With nothing configured, the messages that are already due are sent right
   * here — which is what makes a fresh clone of this repository produce a real
   * confirmation rather than a row waiting for tomorrow's cron. The reminder,
   * which no cron can time properly anyway, waits for the sweep.
   */
  it("sends what is due inline when nothing is configured", async () => {
    const appointmentId = await bookFreely(startsInDays(5));
    const { scheduler } = fakeScheduler({ configured: false });
    const { mailer, sent } = spyMailer();

    const before = await rowsFor(appointmentId);
    expect(before.every((row) => row.status === "pending")).toBe(true);

    /* The inline flush goes through the same worker, so it takes a mailer the
       same way — and a test must never hand fixture addresses to a real one. */
    const result = await dispatchDeliveries(db, appointmentId, {
      scheduler,
      mailer,
    });

    expect(result.scheduler).toBe("cron-only");
    expect(result.scheduled).toBe(0);
    /* One row left pending: the reminder, days away. */
    expect(result.deferred).toBe(1);

    const after = await rowsFor(appointmentId);
    const byKind = Object.fromEntries(after.map((row) => [row.kind, row.status]));

    expect(byKind.confirmation).toBe("sent");
    expect(byKind.new_booking).toBe("sent");
    expect(byKind.reminder).toBe("pending");

    /* Two messages genuinely left the building, in this same call. */
    expect(sent.map((email) => email.subject.split(":")[0]).sort()).toEqual([
      "Booked",
      "New booking",
    ]);
  });

  it("leaves everything to the catch-up when the service refuses", async () => {
    const appointmentId = await bookFreely(startsInDays(5));
    const { scheduler } = fakeScheduler({ refuse: true });

    const result = await dispatchDeliveries(db, appointmentId, { scheduler });

    expect(result).toMatchObject({ scheduled: 0, failed: 3 });

    /* Still pending, still unscheduled — exactly what the sweep looks for. A
       booking is never rolled back because a scheduler was unreachable. */
    for (const row of await rowsFor(appointmentId)) {
      expect(row.status).toBe("pending");
      expect(row.schedulerMessageId).toBeNull();
    }
  });
});

/* ===========================================================================
   Cancelling
   =========================================================================== */

describe("cancelling", () => {
  it("withdraws the rows and calls the scheduled messages off", async () => {
    const appointmentId = await bookFreely(startsInDays(5));
    const { scheduler, cancelled } = fakeScheduler();

    await dispatchDeliveries(db, appointmentId, { scheduler });
    const reminder = await reminderFor(appointmentId);

    const result = await cancelScheduledDeliveries(db, appointmentId, {
      scheduler,
    });

    expect(result.withdrawn).toBe(3);
    expect(result.stuck).toBe(0);
    /* The id stored at dispatch is the one handed back to the service. */
    expect(cancelled).toContain(reminder.schedulerMessageId);

    for (const row of await rowsFor(appointmentId)) {
      expect(row.status).toBe("cancelled");
    }
  });

  it("reports a message it could not call off, and does not throw", async () => {
    const appointmentId = await bookFreely(startsInDays(5));
    const { scheduler } = fakeScheduler({ uncancellable: true });

    await dispatchDeliveries(db, appointmentId, { scheduler });

    const result = await cancelScheduledDeliveries(db, appointmentId, {
      scheduler,
    });

    expect(result.withdrawn).toBe(3);
    expect(result.stuck).toBe(3);
    /* The rows are withdrawn regardless — which is what actually stops the
       send, because the worker re-reads the row on arrival. */
    for (const row of await rowsFor(appointmentId)) {
      expect(row.status).toBe("cancelled");
    }
  });

  /**
   * THE SECOND LINE OF DEFENCE, and the one that actually holds.
   *
   * A scheduled message can already be in flight when an appointment is
   * cancelled, and a delivery service can fail to call one off. So the worker
   * re-reads the appointment before composing anything: a reminder for a
   * cancelled booking is withdrawn on arrival rather than sent.
   */
  it("refuses to send a reminder for a cancelled appointment", async () => {
    const appointmentId = await bookFreely(startsInDays(5));
    const reminder = await reminderFor(appointmentId);

    /* Make it due, and cancel the appointment out from under it without
       touching the outbox — the case where cancellation failed to tidy up. */
    await db
      .update(notifications)
      .set({ scheduledFor: new Date(Date.now() - 60_000) })
      .where(eq(notifications.id, reminder.id));

    await db
      .update(appointments)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(eq(appointments.id, appointmentId));

    const { mailer, sent } = spyMailer();
    const result = await drainNotifications(db, {
      notificationId: reminder.id,
      mailer,
      origin: "https://openings.test",
    });

    expect(result).toMatchObject({ claimed: 1, sent: 0, cancelled: 1 });
    expect(sent).toHaveLength(0);
    expect((await reminderFor(appointmentId)).status).toBe("cancelled");
  });
});

/* ===========================================================================
   Rescheduling
   =========================================================================== */

describe("rescheduling", () => {
  it("calls the old message off and queues one for the new time", async () => {
    const appointmentId = await bookFreely(startsInDays(5));
    const { scheduler, cancelled, published } = fakeScheduler();

    await dispatchDeliveries(db, appointmentId, { scheduler });
    const original = await reminderFor(appointmentId);

    /* The appointment moves two days later — the caller's transaction would do
       this; here it stands in for one. */
    const moved = startsInDays(7);
    await db
      .update(appointments)
      .set({ startsAt: moved })
      .where(eq(appointments.id, appointmentId));

    const result = await rescheduleReminder(db, appointmentId, { scheduler });

    expect(result.withdrawn).toBe(1);
    expect(cancelled).toContain(original.schedulerMessageId);

    /* SAME APPOINTMENT, NEW ROW, NEW MESSAGE. The old row survives as history
       rather than being edited into something it was never queued as. */
    const rows = await rowsFor(appointmentId);
    const reminders = rows.filter((row) => row.kind === "reminder");

    expect(reminders).toHaveLength(2);
    expect(reminders.filter((row) => row.status === "cancelled")).toHaveLength(1);

    const live = reminders.find((row) => row.status === "pending");

    expect(live?.scheduledFor.getTime()).toBe(moved.getTime() - 24 * 60 * 60_000);
    expect(live?.schedulerMessageId).toMatch(/^msg_/);
    expect(result.queuedFor?.getTime()).toBe(moved.getTime() - 24 * 60 * 60_000);

    /* The new publish is for the new instant. */
    expect(
      published.some(
        (message) =>
          message.notificationId === live?.id &&
          message.deliverAt.getTime() === moved.getTime() - 24 * 60 * 60_000,
      ),
    ).toBe(true);
  });

  it("queues no reminder when the new time is inside the window", async () => {
    const appointmentId = await bookFreely(startsInDays(5));
    const { scheduler } = fakeScheduler();

    await dispatchDeliveries(db, appointmentId, { scheduler });

    /* Moved to this afternoon. The correct number of reminders is zero. */
    await db
      .update(appointments)
      .set({ startsAt: new Date(Date.now() + 3 * 60 * 60 * 1000) })
      .where(eq(appointments.id, appointmentId));

    const result = await rescheduleReminder(db, appointmentId, { scheduler });

    expect(result.withdrawn).toBe(1);
    expect(result.queuedFor).toBeNull();

    const pending = (await rowsFor(appointmentId)).filter(
      (row) => row.kind === "reminder" && row.status === "pending",
    );

    expect(pending).toHaveLength(0);
  });

  it("only withdraws when the appointment is no longer confirmed", async () => {
    const appointmentId = await bookFreely(startsInDays(5));
    const { scheduler } = fakeScheduler();

    await dispatchDeliveries(db, appointmentId, { scheduler });

    await db
      .update(appointments)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(eq(appointments.id, appointmentId));

    const result = await rescheduleReminder(db, appointmentId, { scheduler });

    expect(result.withdrawn).toBe(1);
    expect(result.queuedFor).toBeNull();
    expect(result.scheduled).toBe(0);
  });
});

/* ===========================================================================
   The safety net's view
   =========================================================================== */

describe("what the catch-up is carrying", () => {
  it("separates what is scheduled from what the sweep still owns", async () => {
    const scheduledBooking = await bookFreely(startsInDays(5), context.staffA);
    const strandedBooking = await bookFreely(startsInDays(6), context.staffB);

    const { scheduler } = fakeScheduler();
    const { scheduler: broken } = fakeScheduler({ refuse: true });

    await dispatchDeliveries(db, scheduledBooking, { scheduler });
    await dispatchDeliveries(db, strandedBooking, { scheduler: broken });

    /* Only future rows count as "awaiting the sweep" — the immediate ones are
       due now and are the sweep's ordinary work, not a symptom. */
    expect(await countScheduled(db)).toBe(3);
    expect(await countUnscheduled(db)).toBe(1);
  });

  /**
   * A TARGETED DELIVERY MAY ARRIVE A BREATH EARLY.
   *
   * `notBefore` is published in whole seconds and clocks differ, so a message
   * can land a moment before its row is due. Without tolerance it would find
   * nothing to claim, do nothing, and leave the reminder to a sweep up to a
   * day later — for the sake of half a second.
   */
  it("delivers a scheduled message that arrives slightly early", async () => {
    const appointmentId = await bookFreely(startsInDays(5));
    const reminder = await reminderFor(appointmentId);

    await db
      .update(notifications)
      .set({ scheduledFor: sql`now() + interval '20 seconds'` })
      .where(eq(notifications.id, reminder.id));

    const { mailer, sent } = spyMailer();
    const result = await drainNotifications(db, {
      notificationId: reminder.id,
      mailer,
      origin: "https://openings.test",
    });

    expect(result).toMatchObject({ claimed: 1, sent: 1 });
    expect(sent[0].subject).toContain("Tomorrow");
  });

  it("does not deliver one that arrives far too early", async () => {
    const appointmentId = await bookFreely(startsInDays(5));
    const reminder = await reminderFor(appointmentId);

    const { mailer, sent } = spyMailer();
    const result = await drainNotifications(db, {
      notificationId: reminder.id,
      mailer,
      origin: "https://openings.test",
    });

    expect(result.claimed).toBe(0);
    expect(sent).toHaveLength(0);
    expect((await reminderFor(appointmentId)).status).toBe("pending");
  });
});
