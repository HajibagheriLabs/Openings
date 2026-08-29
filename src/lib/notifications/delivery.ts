import "server-only";

import { and, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import {
  appointments,
  businesses,
  customers,
  notifications,
  type NotificationKind,
} from "@/db/schema";

import type { Mailer } from "./mailer";
import { reminderInstantFor } from "./reminder";
import { getScheduler, type Scheduler } from "./scheduler";
import { drainNotifications } from "./worker";

/**
 * The join between the outbox and the delivery service.
 *
 * The outbox says WHAT to send and WHEN. The scheduler makes something wake us
 * at that instant. This module is the only place the two meet, so that every
 * caller — the Stripe webhook, the free-booking action, and the reschedule and
 * cancellation flows — performs the same steps in the same order rather than
 * each remembering to.
 *
 * ═══ NOTHING HERE RUNS INSIDE A BOOKING TRANSACTION ═══
 *
 * Publishing a scheduled message is an HTTP call to a third party. Doing it
 * inside the booking transaction would mean a slow or unreachable QStash could
 * roll back a confirmed, paid-for appointment — the exact failure the outbox
 * pattern exists to prevent. So the transaction writes the row and commits,
 * and scheduling happens AFTER, against a row that is already safe.
 *
 * The consequence is a window: between the commit and the publish, the
 * reminder exists with nothing scheduled against it. That window is correct
 * and needs no compensation, because a pending row with no
 * `scheduler_message_id` is precisely what the daily catch-up looks for. A
 * crash in the middle costs a reminder its punctuality, never its existence.
 */

/**
 * Kinds a reschedule withdraws and re-queues.
 *
 * Only the reminder. A confirmation that has already gone cannot be unsent,
 * and the reschedule notice itself is written by the flow doing the moving.
 */
export const RESCHEDULED_KINDS: NotificationKind[] = ["reminder"];

/**
 * How many immediately-due messages one booking can produce.
 *
 * Three today — the customer's confirmation, the owner's copy, and headroom.
 * A bound rather than an unbounded drain, because this runs in a request the
 * customer is waiting on.
 */
const IMMEDIATE_BATCH = 5;

export interface DispatchOptions {
  /** Injected by tests. Production reads the configured one. */
  scheduler?: Scheduler;
  /** One clock for the whole dispatch. */
  now?: Date;
  /**
   * The mailer the INLINE flush uses, when there is one.
   *
   * Only reachable on the unconfigured path, and only ever set by a test —
   * which needs it, because the alternative is a test suite that sends real
   * email to fixture addresses.
   */
  mailer?: Mailer;
}

/* ===========================================================================
   Dispatch — the one call every booking path makes after it commits
   =========================================================================== */

export interface DeliverySyncResult {
  /** Which implementation ran — "qstash" or "cron-only". */
  scheduler: string;
  /** Messages handed to the delivery service for a future instant. */
  scheduled: number;
  /** Messages sent inline, right now, because nothing else was going to. */
  sentNow: number;
  /** Left for the daily catch-up, on purpose. */
  deferred: number;
  /** The service refused. Also the catch-up's problem now. */
  failed: number;
}

/**
 * Get every queued message for this appointment on its way.
 *
 * Called AFTER the booking transaction commits, by the Stripe webhook and by
 * the free-booking action. IDEMPOTENT: a row already carrying a
 * `scheduler_message_id` is left alone, so a retried webhook or a double
 * submit cannot produce two reminders for one booking.
 *
 * ═══ TWO MODES, AND BOTH DELIVER ═══
 *
 * WITH A DELIVERY SERVICE, every pending row is published to it — the reminder
 * for its exact instant weeks out, the confirmation for right now. The
 * confirmation could be sent inline instead, and deliberately is not: this runs
 * inside a Stripe webhook, which has to answer fast and must not have an email
 * provider's latency in its critical path. Handing both to the same service
 * keeps this call to one round trip per message and puts the retries somewhere
 * that survives the request ending.
 *
 * WITHOUT ONE, anything already due is sent INLINE, here, and only genuinely
 * future messages fall to the daily catch-up. That is what makes the product
 * whole on a laptop with nothing but a database: a booking still produces a
 * confirmation within seconds, and the reminder — which no cron can time
 * properly anyway — waits for the sweep. See the note at the top of
 * ./scheduler.ts.
 *
 * NOTHING HERE THROWS. It runs after a booking is already committed and paid
 * for; turning a late reminder into an error on the customer's confirmation
 * screen would be a far worse bug than the one it reported.
 */
export async function dispatchDeliveries(
  db: Db,
  appointmentId: string,
  options: DispatchOptions = {},
): Promise<DeliverySyncResult> {
  const scheduler = options.scheduler ?? getScheduler();
  const now = options.now ?? new Date();

  const result: DeliverySyncResult = {
    scheduler: scheduler.name,
    scheduled: 0,
    sentNow: 0,
    deferred: 0,
    failed: 0,
  };

  if (!scheduler.configured) {
    /**
     * THE FALLBACK PATH, and it is a first-class one.
     *
     * Send what is due and leave the rest. `drainNotifications` is the same
     * worker the cron and the scheduled route use, with the same lease and the
     * same liveness check — so an inline flush cannot race the sweep into
     * sending anything twice.
     */
    const drained = await drainNotifications(db, {
      appointmentId,
      limit: IMMEDIATE_BATCH,
      now,
      mailer: options.mailer,
    }).catch((error: unknown) => {
      console.warn(
        `[delivery] inline flush for appointment ${appointmentId} failed: ` +
          `${messageOf(error)}. The daily catch-up will deliver it.`,
      );

      return null;
    });

    result.sentNow = drained?.sent ?? 0;
    result.deferred = await countPendingFor(db, appointmentId);

    return result;
  }

  const pending = await db
    .select({ id: notifications.id, scheduledFor: notifications.scheduledFor })
    .from(notifications)
    .where(
      and(
        eq(notifications.appointmentId, appointmentId),
        eq(notifications.status, "pending"),
        /* Never publish twice for one row. */
        isNull(notifications.schedulerMessageId),
      ),
    );

  for (const row of pending) {
    const outcome = await scheduler.schedule({
      notificationId: row.id,
      /* A row that is already due is published for NOW rather than for a
         timestamp in the past. QStash accepts either, but "now" is what it
         means and it is what the dedup key should say. */
      deliverAt:
        row.scheduledFor.getTime() > now.getTime() ? row.scheduledFor : now,
    });

    if (outcome.status === "scheduled") {
      /* WHERE status = 'pending' so a message id is never written onto a row
         that was sent or withdrawn while we were publishing. */
      await db
        .update(notifications)
        .set({ schedulerMessageId: outcome.messageId })
        .where(
          and(eq(notifications.id, row.id), eq(notifications.status, "pending")),
        );

      result.scheduled += 1;
      continue;
    }

    if (outcome.status === "failed") {
      console.warn(
        `[delivery] could not schedule notification ${row.id}: ${outcome.reason}. ` +
          "The daily catch-up will deliver it.",
      );
      result.failed += 1;
      continue;
    }

    result.deferred += 1;
  }

  return result;
}

/** Pending rows still waiting on this appointment, whatever is coming for them. */
async function countPendingFor(db: Db, appointmentId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.appointmentId, appointmentId),
        eq(notifications.status, "pending"),
      ),
    );

  return row?.count ?? 0;
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/* ===========================================================================
   Cancelling
   =========================================================================== */

export interface DeliveryCancelResult {
  scheduler: string;
  /** Outbox rows moved to `cancelled`. */
  withdrawn: number;
  /**
   * Scheduled messages the service would not call off.
   *
   * Not fatal, and this is why: the delivery route re-reads the row before
   * sending anything, finds it `cancelled`, and refuses. The message arrives
   * and does nothing. The count is reported so a persistent failure to reach
   * the scheduler is visible rather than silent.
   */
  stuck: number;
}

/**
 * Withdraw every message still queued for this appointment.
 *
 * TWO HALVES, BOTH REQUIRED. Moving the row to `cancelled` makes the decision
 * durable — it survives a crash, and it is what the delivery route checks.
 * Calling the scheduler off stops a wake-up that would otherwise arrive with
 * nothing to do.
 *
 * THE ROW IS WRITTEN FIRST, and the order is the whole safety argument. If the
 * process dies between the two, a message fires, the route reads a `cancelled`
 * row, and nothing is sent. The other order would leave a live row with no
 * scheduled delivery — a reminder that silently never arrives, which is
 * strictly worse than one that arrives and is refused.
 *
 * `scheduler_message_id` is deliberately NOT cleared: on a withdrawn row it is
 * the record of which message was called off, and clearing it would also make
 * the id unreadable from the same statement that withdrew it.
 */
export async function cancelScheduledDeliveries(
  db: Db,
  appointmentId: string,
  options: { scheduler?: Scheduler; kinds?: NotificationKind[] } = {},
): Promise<DeliveryCancelResult> {
  const scheduler = options.scheduler ?? getScheduler();

  const withdrawn = await db
    .update(notifications)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(notifications.appointmentId, appointmentId),
        eq(notifications.status, "pending"),
        ...(options.kinds ? [inArray(notifications.kind, options.kinds)] : []),
      ),
    )
    .returning({
      id: notifications.id,
      messageId: notifications.schedulerMessageId,
    });

  let stuck = 0;

  for (const row of withdrawn) {
    if (!row.messageId) {
      continue;
    }

    if (!(await scheduler.cancel(row.messageId))) {
      stuck += 1;
    }
  }

  return { scheduler: scheduler.name, withdrawn: withdrawn.length, stuck };
}

/* ===========================================================================
   Rescheduling
   =========================================================================== */

export interface ReminderResyncResult extends DeliverySyncResult {
  /** Old reminder rows withdrawn, and their scheduled deliveries called off. */
  withdrawn: number;
  /** The new reminder's instant, or null when the new time does not want one. */
  queuedFor: Date | null;
}

/** Nothing scheduled, nothing sent — the shape both early exits below return. */
function nothingQueued(
  scheduler: string,
  withdrawn: number,
): ReminderResyncResult {
  return {
    scheduler,
    scheduled: 0,
    sentNow: 0,
    deferred: 0,
    failed: 0,
    withdrawn,
    queuedFor: null,
  };
}

/**
 * The appointment moved. Withdraw the old reminder and queue the right one.
 *
 * A MOVED APPOINTMENT CANNOT REUSE ITS REMINDER ROW. The row was written
 * against the old instant and a message was published for that instant, so
 * editing it in place would leave the service holding a wake-up for a time
 * that no longer means anything. Worse, the new time may want no reminder at
 * all: an appointment moved to this afternoon is inside the reminder window,
 * and the correct number of reminders for it is zero.
 *
 * So: withdraw, then re-queue from scratch against the appointment as it now
 * stands. Cancel-before-queue, so there is never an instant with two live
 * reminders for one booking.
 *
 * Safe to call when nothing changed, and safe to call twice.
 */
export async function rescheduleReminder(
  db: Db,
  appointmentId: string,
  options: DispatchOptions = {},
): Promise<ReminderResyncResult> {
  const now = options.now ?? new Date();

  const cancelled = await cancelScheduledDeliveries(db, appointmentId, {
    ...options,
    kinds: RESCHEDULED_KINDS,
  });

  const [row] = await db
    .select({
      status: appointments.status,
      startsAt: appointments.startsAt,
      reminderLeadMin: businesses.reminderLeadMin,
      customerEmail: customers.email,
    })
    .from(appointments)
    .innerJoin(businesses, eq(businesses.id, appointments.businessId))
    .innerJoin(customers, eq(customers.id, appointments.customerId))
    .where(eq(appointments.id, appointmentId))
    .limit(1);

  /* No customer, or no longer a live booking: withdrawing was the whole job.
     A cancelled appointment reaching here is the ordinary case — the caller
     cancelled it and is tidying up after itself. */
  if (!row || row.status !== "confirmed") {
    return nothingQueued(cancelled.scheduler, cancelled.withdrawn);
  }

  const queuedFor = reminderInstantFor({
    startsAt: row.startsAt,
    reminderLeadMin: row.reminderLeadMin,
    now,
  });

  if (!queuedFor) {
    /* Moved to inside the reminder window. No row, no message, no apology —
       the customer simply gets the messages this booking still deserves. */
    return nothingQueued(cancelled.scheduler, cancelled.withdrawn);
  }

  await db.insert(notifications).values({
    appointmentId,
    kind: "reminder",
    channel: "email",
    toEmail: row.customerEmail,
    scheduledFor: queuedFor,
  });

  const scheduled = await dispatchDeliveries(db, appointmentId, options);

  return { ...scheduled, withdrawn: cancelled.withdrawn, queuedFor };
}

/* ===========================================================================
   What the catch-up is carrying
   =========================================================================== */

/**
 * Pending future messages with nobody coming for them.
 *
 * Reported by the daily cron and shown in the admin, because "reminders are
 * scheduled individually" and "reminders are waiting for tomorrow's sweep" are
 * different operational realities and an owner is entitled to know which one
 * they are in.
 */
export async function countUnscheduled(db: Db): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.status, "pending"),
        isNull(notifications.schedulerMessageId),
        gt(notifications.scheduledFor, sql`now()`),
      ),
    );

  return row?.count ?? 0;
}

/** Pending messages that DO have a scheduled delivery waiting for them. */
export async function countScheduled(db: Db): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.status, "pending"),
        isNotNull(notifications.schedulerMessageId),
      ),
    );

  return row?.count ?? 0;
}
