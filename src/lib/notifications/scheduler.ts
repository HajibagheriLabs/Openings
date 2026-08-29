import "server-only";

import { Client } from "@upstash/qstash";

import { clientEnv, serverEnv } from "@/env";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY REMINDERS ARE SCHEDULED PER BOOKING RATHER THAN SWEPT BY THE CRON
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE CONSTRAINT, stated plainly because everything below is shaped by it:
 *
 *   A Vercel Hobby project may run AT MOST ONE CRON JOB PER DAY, and Vercel
 *   does not guarantee the minute. A job declared for 09:00 fires somewhere
 *   inside the 09:00 hour, and on a free plan it may be deferred further.
 *
 * That is unusable as the mechanism for "24 hours before the appointment".
 * A once-a-day sweep can only ever ask "is anything due before tomorrow's
 * run?", which forces one of two bad answers: send everything due in the next
 * 24 hours — so a reminder for a 5pm appointment goes out at 9am the day
 * before, 32 hours early — or send only what is already overdue, so the same
 * reminder arrives after the appointment has happened. There is no third
 * option, because the resolution of the job is a day and the requirement is a
 * minute.
 *
 * So the cron is NOT the mechanism. Each reminder gets its OWN scheduled
 * delivery, published at booking time for its exact instant: one HTTP callback
 * from Upstash QStash to our worker route, carrying the notification id. The
 * daily cron becomes a safety net that catches whatever the scheduler did not
 * deliver — see src/app/api/cron/daily/route.ts, which says so at length.
 *
 * ═══ THE FALLBACK IS A FIRST-CLASS PATH, NOT A DEGRADED ONE ═══
 *
 * With no QSTASH_TOKEN this returns a scheduler that schedules nothing and
 * says so. Every reminder then waits for the daily catch-up, which is late but
 * never wrong — the outbox row is the source of truth either way, and the
 * worker cannot tell who woke it. That is deliberate: somebody cloning this
 * repository can complete a whole booking, receive a confirmation and see a
 * reminder delivered without registering for anything. The admin area states
 * which mode is running rather than leaving it to be discovered.
 */

/** What the delivery service hands back, or why it did nothing. */
export type ScheduleOutcome =
  /** Published. `messageId` is the handle used to call it off later. */
  | { status: "scheduled"; messageId: string }
  /**
   * Nothing was published, and that is fine. `reason` is for the log and the
   * admin panel, never for a customer.
   */
  | { status: "skipped"; reason: string }
  /** The service refused or was unreachable. The daily catch-up will cover it. */
  | { status: "failed"; reason: string };

export interface Scheduler {
  /** Named so logs and the admin panel can say which implementation ran. */
  readonly name: string;
  /** Whether real scheduling is happening, or the cron is carrying everything. */
  readonly configured: boolean;
  /** Publish a delivery for one notification, at one instant. */
  schedule(input: {
    notificationId: string;
    /** The exact moment the message should be delivered. */
    deliverAt: Date;
  }): Promise<ScheduleOutcome>;
  /**
   * Call off a scheduled delivery.
   *
   * Returns whether the message is now definitely not going to fire. A message
   * that has already been delivered, or that the service has forgotten, counts
   * as cancelled — there is nothing left to stop.
   */
  cancel(messageId: string): Promise<boolean>;
}

/** Where a scheduled delivery lands. One route, one job. */
export const DELIVERY_PATH = "/api/notifications/deliver";

/**
 * A scheduled message is retried by the service if our route fails.
 *
 * Three, and the deliveries are minutes apart. Beyond that the outbox row's own
 * backoff takes over — the row is still `pending`, so the next cron sweep picks
 * it up regardless of what the delivery service concluded.
 */
const DELIVERY_RETRIES = 3;

/* ===========================================================================
   The no-op implementation
   =========================================================================== */

/**
 * Schedules nothing, and is not a stub.
 *
 * It is what runs when QSTASH_TOKEN is unset, and it is the reason the product
 * works end to end on a laptop. Every reminder falls to the daily catch-up,
 * which is exactly the behaviour the safety net exists to provide — the
 * fallback is simply doing its job earlier than usual.
 */
class UnscheduledDelivery implements Scheduler {
  readonly name = "cron-only";
  readonly configured = false;

  constructor(private readonly why: string) {}

  async schedule(): Promise<ScheduleOutcome> {
    return { status: "skipped", reason: this.why };
  }

  async cancel(): Promise<boolean> {
    /* Nothing was ever scheduled, so nothing can fire. Reporting success here
       is not a lie: the caller asked for the message not to be delivered, and
       it will not be. */
    return true;
  }
}

/* ===========================================================================
   QStash
   =========================================================================== */

class QStashScheduler implements Scheduler {
  readonly name = "qstash";
  readonly configured = true;

  constructor(
    private readonly client: Client,
    private readonly deliveryUrl: string,
  ) {}

  async schedule(input: {
    notificationId: string;
    deliverAt: Date;
  }): Promise<ScheduleOutcome> {
    try {
      const { messageId } = await this.client.publishJSON({
        url: this.deliveryUrl,
        body: { notificationId: input.notificationId },
        /**
         * SECONDS, not milliseconds — QStash's `notBefore` is a Unix timestamp
         * in seconds, and passing milliseconds would schedule the reminder
         * roughly fifty thousand years out with no error anywhere.
         *
         * Rounded DOWN, so a message can only ever be a fraction of a second
         * early rather than a fraction late. The route tolerates a little
         * earliness by design; see `CLAIM_TOLERANCE_SECONDS`.
         */
        notBefore: Math.floor(input.deliverAt.getTime() / 1000),
        retries: DELIVERY_RETRIES,
        /**
         * Dedup on the notification AND the instant.
         *
         * Publishing the same reminder twice — a retried webhook, a double
         * submit — must not produce two deliveries. Including the instant is
         * what keeps a genuine RESCHEDULE working: the appointment moved, so
         * the new message has a different key and is accepted rather than
         * silently swallowed as a duplicate of the one we just cancelled.
         */
        deduplicationId: `${input.notificationId}:${Math.floor(
          input.deliverAt.getTime() / 1000,
        )}`,
      });

      return { status: "scheduled", messageId };
    } catch (error) {
      /**
       * NEVER THROWN ONWARD.
       *
       * Scheduling happens after the booking transaction has already
       * committed. Letting this propagate would turn "the reminder is late"
       * into "the confirmation page showed an error for a booking that was
       * successfully made and paid for". The row stays `pending` with no
       * message id, and the daily catch-up delivers it.
       */
      return { status: "failed", reason: messageOf(error) };
    }
  }

  async cancel(messageId: string): Promise<boolean> {
    try {
      const { cancelled } = await this.client.messages.cancel(messageId);

      return cancelled > 0;
    } catch (error) {
      /**
       * A message that was already delivered, or that QStash has forgotten,
       * answers 404 here. That is a SUCCESS for our purposes — the thing we
       * wanted not to fire is not going to fire.
       *
       * Anything else is a real failure, and it matters: an uncancelled
       * reminder for a cancelled appointment is a message that contradicts the
       * product. It is logged loudly, and the delivery route re-checks the
       * appointment's status before sending anything, which is the second line
       * of defence and the one that actually holds.
       */
      if (isNotFound(error)) {
        return true;
      }

      console.error(
        `[scheduler] could not cancel scheduled message ${messageId}. ` +
          `The delivery route will refuse it on arrival if the appointment has moved.`,
        error,
      );

      return false;
    }
  }
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/** QStash reports a vanished message as a 404 in the error text. */
function isNotFound(error: unknown): boolean {
  return /\b404\b|not found/i.test(messageOf(error));
}

/* ===========================================================================
   Selection
   =========================================================================== */

/**
 * QStash delivers by making an HTTP request to a URL IT CAN REACH.
 *
 * `http://localhost:3000` is not one. A scheduled message against it is
 * accepted, retried a few times against nothing, and quietly lands in a dead
 * letter queue — which looks exactly like a broken product to somebody running
 * the repo for the first time, and costs them their QStash quota to discover.
 *
 * So a local origin is treated as "not configured" even with a token present.
 * The daily catch-up runs the reminders instead, which is the documented
 * behaviour rather than a surprise. Point NEXT_PUBLIC_APP_URL at a tunnel to
 * exercise the real path locally.
 */
export function isLocalOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);

    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "::1" ||
      hostname.endsWith(".localhost")
    );
  } catch {
    /* An origin that will not parse cannot be published against either. */
    return true;
  }
}

/** One instance per process; the client holds a keep-alive agent. */
const globalForScheduler = globalThis as unknown as {
  __openingsScheduler?: Scheduler;
};

export function getScheduler(): Scheduler {
  return (globalForScheduler.__openingsScheduler ??= buildScheduler());
}

function buildScheduler(): Scheduler {
  const token = serverEnv.QSTASH_TOKEN;

  if (!token) {
    return new UnscheduledDelivery(
      "QSTASH_TOKEN is not set — the daily catch-up delivers reminders.",
    );
  }

  const origin = clientEnv.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");

  if (isLocalOrigin(origin)) {
    return new UnscheduledDelivery(
      `NEXT_PUBLIC_APP_URL is ${origin}, which the delivery service cannot reach — ` +
        "the daily catch-up delivers reminders.",
    );
  }

  return new QStashScheduler(new Client({ token }), `${origin}${DELIVERY_PATH}`);
}

/** For tests, which install their own. */
export function setSchedulerForTesting(scheduler: Scheduler | undefined): void {
  globalForScheduler.__openingsScheduler = scheduler;
}
