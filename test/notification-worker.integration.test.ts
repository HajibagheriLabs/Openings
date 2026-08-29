import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/db/client";
import { appointments, notifications } from "@/db/schema";
import type { Mailer, OutboundEmail } from "@/lib/notifications/mailer";
import {
  backoffSeconds,
  BACKOFF_CAP_SECONDS,
  drainNotifications,
  MAX_ATTEMPTS,
} from "@/lib/notifications/worker";
import { createHold } from "@/lib/scheduling/booking";

import { at, clearAppointments, setupTestDatabase } from "./helpers/database";

/**
 * The outbox worker, against a real Postgres.
 *
 * Everything interesting about this worker is a database behaviour, so none of
 * it can be proved without one: the claim is a `FOR UPDATE SKIP LOCKED` plus a
 * lease written onto `scheduled_for`, the retry is that same column pushed
 * forward, and "give up" is a status transition. A mocked database would only
 * assert that the code calls the functions it calls.
 *
 * The mailer IS mocked — it is the one boundary that leaves the machine.
 */

let context: Awaited<ReturnType<typeof setupTestDatabase>>;
let db: Db;

const ORIGIN = "https://openings.test";

beforeAll(async () => {
  context = await setupTestDatabase();
  db = context.db;
});

afterAll(async () => {
  await context.pool.end();
});

beforeEach(async () => {
  await clearAppointments(db);
});

/* ===========================================================================
   Fixtures
   =========================================================================== */

/** A recording mailer. `fail` makes every send throw, like a provider outage. */
function spyMailer(options: { fail?: string } = {}) {
  const sent: OutboundEmail[] = [];

  const mailer: Mailer = {
    name: "spy",
    async send(email) {
      if (options.fail) {
        throw new Error(options.fail);
      }

      sent.push(email);
    },
  };

  return { mailer, sent };
}

/**
 * A confirmed appointment with a customer on it, and one queued message.
 *
 * Written through `createHold` rather than by hand so the row carries a real
 * `ics_uid` — the manage token the worker puts in the email is derived from
 * it, and a fabricated UID would produce a link that does not open.
 */
async function queueConfirmation(scheduledFor: Date, hour = 9) {
  const { appointment } = await createHold(db, {
    businessId: context.businessId,
    staffId: context.staffA,
    serviceId: context.plainServiceId,
    startsAt: at(hour),
  });

  await db
    .update(appointments)
    .set({
      status: "confirmed",
      holdExpiresAt: null,
      customerId: context.customerId,
      stripePaymentIntentId: "pi_test_worker",
      depositCents: 2000,
    })
    .where(eq(appointments.id, appointment.id));

  const [row] = await db
    .insert(notifications)
    .values({
      appointmentId: appointment.id,
      kind: "confirmation",
      channel: "email",
      toEmail: "sam@example.test",
      scheduledFor,
    })
    .returning();

  return { appointmentId: appointment.id, notificationId: row.id };
}

async function readNotification(id: string) {
  const [row] = await db
    .select()
    .from(notifications)
    .where(eq(notifications.id, id))
    .limit(1);

  return row;
}

/* ===========================================================================
   Backoff — pure, but it belongs beside what it governs
   =========================================================================== */

describe("the backoff", () => {
  it("doubles, and stops doubling at the cap", () => {
    expect(backoffSeconds(1)).toBe(60);
    expect(backoffSeconds(2)).toBe(120);
    expect(backoffSeconds(3)).toBe(240);
    expect(backoffSeconds(4)).toBe(480);

    /* Deterministic, with no jitter: a single worker walking a queue does not
       need to spread a thundering herd, and a schedule a test can assert is a
       schedule an owner can be told about. */
    expect(backoffSeconds(20)).toBe(BACKOFF_CAP_SECONDS);
  });
});

/* ===========================================================================
   The drain
   =========================================================================== */

describe("draining the outbox", () => {
  it("sends a due message, with its invitation, and marks it sent", async () => {
    const { notificationId } = await queueConfirmation(new Date());
    const { mailer, sent } = spyMailer();

    const result = await drainNotifications(db, { mailer, origin: ORIGIN });

    expect(result).toMatchObject({ claimed: 1, sent: 1, retrying: 0, failed: 0 });

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("sam@example.test");
    expect(sent[0].subject).toContain("Booked");
    expect(sent[0].html).toContain(`${ORIGIN}/manage/`);

    /* ONE calendar part, carrying the method. Two attachments is how a client
       stops rendering an invitation and starts rendering a paperclip. */
    expect(sent[0].calendar?.contentType).toContain("method=REQUEST");
    expect(sent[0].calendar?.content).toContain("BEGIN:VEVENT");

    const row = await readNotification(notificationId);

    expect(row.status).toBe("sent");
    expect(row.sentAt).not.toBeNull();
    expect(row.lastError).toBeNull();
    expect(row.attempts).toBe(1);
  });

  it("leaves a message that is not due yet alone", async () => {
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    const { notificationId } = await queueConfirmation(soon);
    const { mailer, sent } = spyMailer();

    const result = await drainNotifications(db, { mailer, origin: ORIGIN });

    expect(result.claimed).toBe(0);
    expect(sent).toHaveLength(0);
    expect((await readNotification(notificationId)).status).toBe("pending");
  });

  /**
   * THE LEASE.
   *
   * Two workers overlap eventually — the per-booking reminder call and the
   * daily safety-net cron will meet. Claiming pushes `scheduled_for` forward,
   * so a second drain a moment later sees nothing due and the customer gets
   * one confirmation rather than two.
   */
  it("does not send the same message twice when two drains overlap", async () => {
    await queueConfirmation(new Date());

    const first = spyMailer();
    const second = spyMailer();

    const a = await drainNotifications(db, {
      mailer: first.mailer,
      origin: ORIGIN,
    });
    const b = await drainNotifications(db, {
      mailer: second.mailer,
      origin: ORIGIN,
    });

    expect(a.sent).toBe(1);
    expect(b.claimed).toBe(0);
    expect(second.sent).toHaveLength(0);
  });

  it("records a failure, backs off, and stays pending", async () => {
    const { notificationId } = await queueConfirmation(new Date());
    const { mailer } = spyMailer({ fail: "Resend refused the message: 429" });

    const result = await drainNotifications(db, { mailer, origin: ORIGIN });

    expect(result).toMatchObject({ sent: 0, retrying: 1, failed: 0 });
    expect(result.outcomes[0]).toMatchObject({
      status: "retrying",
      attempts: 1,
      retryInSeconds: 60,
    });

    const row = await readNotification(notificationId);

    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("429");
    /* Due again in about a minute — the retry and the claim lease are the same
       mechanism, which is why neither needs a column of its own. */
    expect(row.scheduledFor.getTime()).toBeGreaterThan(Date.now() + 30_000);
    expect(row.scheduledFor.getTime()).toBeLessThan(Date.now() + 120_000);
  });

  it("gives up after MAX_ATTEMPTS and says so on the row", async () => {
    const { notificationId } = await queueConfirmation(new Date());
    const { mailer } = spyMailer({ fail: "mailbox does not exist" });

    /* One attempt short of the limit, so the next failure is the last. */
    await db
      .update(notifications)
      .set({ attempts: MAX_ATTEMPTS - 1 })
      .where(eq(notifications.id, notificationId));

    const result = await drainNotifications(db, { mailer, origin: ORIGIN });

    expect(result).toMatchObject({ retrying: 0, failed: 1 });

    const row = await readNotification(notificationId);

    /* A permanent state, visible in the admin area. Far better than a queue
       quietly retrying a dead address until the end of time. */
    expect(row.status).toBe("failed");
    expect(row.lastError).toContain("mailbox does not exist");
  });

  it("fails immediately, without retrying, when the appointment is unsendable", async () => {
    /* A hold has no customer yet, so there is no name to open with and no
       policy to state. Retrying that eight times over two hours produces eight
       identical log lines and no email. */
    const { appointment } = await createHold(db, {
      businessId: context.businessId,
      staffId: context.staffB,
      serviceId: context.plainServiceId,
      startsAt: at(11),
    });

    const [row] = await db
      .insert(notifications)
      .values({
        appointmentId: appointment.id,
        kind: "confirmation",
        channel: "email",
        toEmail: "nobody@example.test",
        scheduledFor: new Date(),
      })
      .returning();

    const { mailer, sent } = spyMailer();
    const result = await drainNotifications(db, { mailer, origin: ORIGIN });

    expect(result).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
    expect(sent).toHaveLength(0);
    expect((await readNotification(row.id)).status).toBe("failed");
  });

  it("takes the oldest first, and no more than the batch size", async () => {
    const base = Date.now() - 60_000;

    await queueConfirmation(new Date(base), 9);
    const second = await queueConfirmation(new Date(base + 1_000), 13);

    const { mailer, sent } = spyMailer();

    const result = await drainNotifications(db, {
      mailer,
      origin: ORIGIN,
      limit: 1,
    });

    expect(result.claimed).toBe(1);
    expect(sent).toHaveLength(1);
    /* The second is untouched and still due. */
    expect((await readNotification(second.notificationId)).status).toBe(
      "pending",
    );
  });
});
