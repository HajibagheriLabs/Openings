import "server-only";

import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import { notifications, type Notification } from "@/db/schema";

import { composeNotification, describeNotification } from "./compose";
import { loadNotificationSubject } from "./context";
import { getMailer, type Mailer } from "./mailer";

/**
 * The outbox worker.
 *
 * Nothing in this product sends an email inline with a booking. A booking
 * transaction writes a row to `notifications` and commits; this drains it.
 * That split is what stops a Resend outage from rolling back a confirmed
 * appointment, and what stops a slow provider from pushing a Stripe webhook
 * past its timeout and earning a retry.
 *
 * ═══ THE CLAIM, AND WHY IT IS A LEASE ═══
 *
 * Two workers can run at once — the QStash call for a reminder and the daily
 * cron will eventually overlap — and a customer receiving two identical
 * confirmations is a bug people notice. So claiming happens in one
 * transaction:
 *
 *   1. SELECT ... FOR UPDATE SKIP LOCKED picks rows nobody else is holding.
 *   2. The same transaction increments `attempts` and pushes `scheduled_for`
 *      forward by CLAIM_LEASE_SECONDS.
 *
 * Step 2 is the whole trick. `scheduled_for` already means "due at", so
 * pushing it forward makes the row invisible to any other worker's "what is
 * due?" query for the length of the lease — a lock that survives the
 * transaction ending, without adding a `claimed_at` column that would then
 * need its own cleanup. If this process dies mid-send, the row simply becomes
 * due again a few minutes later and is retried by whoever runs next. Nothing
 * has to notice the crash.
 *
 * `attempts` is incremented AT CLAIM TIME rather than on failure, for the same
 * reason: a row that reliably kills the process would otherwise be retried for
 * ever, because the increment would never run.
 *
 * ═══ FAILURE ═══
 *
 * A failed send stores the error, leaves the row `pending`, and pushes
 * `scheduled_for` out by an exponentially growing delay. After MAX_ATTEMPTS
 * the row becomes `failed` and stops — a permanent state that shows up in the
 * admin area, which is the honest answer to "we cannot deliver this" and far
 * better than a queue quietly retrying a bad address until the end of time.
 */

/** How long a claimed row is invisible to other workers. */
export const CLAIM_LEASE_SECONDS = 5 * 60;

/** After this many tries the row is `failed` and nobody retries it. */
export const MAX_ATTEMPTS = 8;

/** First retry delay. Doubles each attempt, capped below. */
export const BACKOFF_BASE_SECONDS = 60;

/** No retry is ever further out than this. */
export const BACKOFF_CAP_SECONDS = 2 * 60 * 60;

/** Rows per drain. Small enough to finish inside a serverless invocation. */
export const DEFAULT_BATCH = 25;

/**
 * How long to wait after `attempts` failures.
 *
 * Exponential, and DELIBERATELY WITHOUT JITTER. Jitter matters when a crowd of
 * clients is retrying against one dependency; here a single worker is walking
 * a queue, and a deterministic schedule is one a test can assert and an owner
 * can be told ("we will try again in about eight minutes").
 */
export function backoffSeconds(attempts: number): number {
  const delay = BACKOFF_BASE_SECONDS * 2 ** Math.max(attempts - 1, 0);

  return Math.min(delay, BACKOFF_CAP_SECONDS);
}

/* ===========================================================================
   Results
   =========================================================================== */

export type DeliveryOutcome =
  /** Delivered. */
  | { status: "sent"; id: string; kind: string; to: string; detail: string }
  /** Failed, and will be tried again. `retryInSeconds` says when. */
  | {
      status: "retrying";
      id: string;
      kind: string;
      attempts: number;
      retryInSeconds: number;
      error: string;
    }
  /** Given up on: out of attempts, or unsendable in a way retrying cannot fix. */
  | { status: "failed"; id: string; kind: string; attempts: number; error: string };

export interface DrainResult {
  claimed: number;
  sent: number;
  retrying: number;
  failed: number;
  /** Which mailer ran, so a log line can say whether anything actually left. */
  mailer: string;
  outcomes: DeliveryOutcome[];
}

/* ===========================================================================
   Claiming
   =========================================================================== */

async function claimDue(
  db: Db,
  limit: number,
  now: Date | undefined,
): Promise<Notification[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.status, "pending"),
          /**
           * THE DATABASE'S CLOCK DECIDES, as it does everywhere else in this
           * codebase. The lease below and the backoff are both written with
           * SQL `now()`, so reading "what is due?" off the application
           * server's clock instead would let a skewed instance claim rows
           * early — or, worse, refuse to claim rows it had itself scheduled.
           * An explicit `now` is for tests, and nothing else passes one.
           */
          now
            ? lte(notifications.scheduledFor, now)
            : sql`${notifications.scheduledFor} <= now()`,
        ),
      )
      /* Oldest first. A confirmation queued before a reminder should leave
         before it, even when a backlog means both are due at once. */
      .orderBy(asc(notifications.scheduledFor))
      .limit(limit)
      /* SKIP LOCKED rather than waiting: a second worker should take the next
         row, not queue up behind this one. */
      .for("update", { skipLocked: true });

    if (due.length === 0) {
      return [];
    }

    return tx
      .update(notifications)
      .set({
        attempts: sql`${notifications.attempts} + 1`,
        /* The lease. See the note at the top of this file. */
        scheduledFor: sql`now() + make_interval(secs => ${CLAIM_LEASE_SECONDS}::int)`,
      })
      .where(
        inArray(
          notifications.id,
          due.map((row) => row.id),
        ),
      )
      .returning();
  });
}

/* ===========================================================================
   Marking
   =========================================================================== */

async function markSent(db: Db, id: string): Promise<void> {
  await db
    .update(notifications)
    .set({ status: "sent", sentAt: new Date(), lastError: null })
    .where(eq(notifications.id, id));
}

/**
 * Store the error and decide whether there is another try in it.
 *
 * `permanent` short-circuits the attempt count for the failures retrying
 * cannot fix — an appointment whose rows are not all there, a template that
 * throws. Trying those eight times over two hours produces eight identical
 * log lines and no email.
 */
async function markFailure(
  db: Db,
  row: Notification,
  error: string,
  permanent: boolean,
): Promise<DeliveryOutcome> {
  const spent = permanent || row.attempts >= MAX_ATTEMPTS;

  if (spent) {
    await db
      .update(notifications)
      .set({ status: "failed", lastError: error })
      .where(eq(notifications.id, row.id));

    return {
      status: "failed",
      id: row.id,
      kind: row.kind,
      attempts: row.attempts,
      error,
    };
  }

  const retryInSeconds = backoffSeconds(row.attempts);

  await db
    .update(notifications)
    .set({
      lastError: error,
      /* Still `pending`. The row is simply due later — which is the same
         mechanism as the claim lease, and the reason neither needs a column of
         its own. */
      scheduledFor: sql`now() + make_interval(secs => ${retryInSeconds}::int)`,
    })
    .where(eq(notifications.id, row.id));

  return {
    status: "retrying",
    id: row.id,
    kind: row.kind,
    attempts: row.attempts,
    retryInSeconds,
    error,
  };
}

/** An exception, reduced to something worth storing in a text column. */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);

  /* `last_error` is read by a person in the admin area, not parsed. A stack
     trace in a table cell helps nobody, and an unbounded string from a
     provider is a row nobody can scroll past. */
  return text.slice(0, 500);
}

/* ===========================================================================
   The drain
   =========================================================================== */

export interface DrainOptions {
  /** Rows to attempt in one call. */
  limit?: number;
  /**
   * Override "what is due?" with an explicit instant.
   *
   * For tests only. Left unset — which is every real caller — the DATABASE'''s
   * clock decides, matching the lease and the backoff.
   */
  now?: Date;
  /** Injectable, so a test can assert what would have been sent. */
  mailer?: Mailer;
  /** Overrides the configured origin. Used by nothing but tests. */
  origin?: string;
}

/**
 * Send everything that is due, one row at a time.
 *
 * SEQUENTIAL ON PURPOSE. The batch is small, the provider rate-limits, and a
 * failure in one message must not take a sibling's send down with it —
 * `Promise.all` would do exactly that. Walking the list also means a drain
 * that runs out of time has still delivered a prefix of it rather than
 * half-finishing everything.
 */
export async function drainNotifications(
  db: Db,
  options: DrainOptions = {},
): Promise<DrainResult> {
  const mailer = options.mailer ?? getMailer();
  const claimed = await claimDue(db, options.limit ?? DEFAULT_BATCH, options.now);

  const outcomes: DeliveryOutcome[] = [];

  for (const row of claimed) {
    try {
      const subject = await loadNotificationSubject(db, row.appointmentId, {
        kind: row.kind,
        payload: row.payload,
        origin: options.origin,
      });

      if (!subject) {
        outcomes.push(
          await markFailure(
            db,
            row,
            `Appointment ${row.appointmentId} has no customer, service or staff to describe.`,
            /* Permanent: nothing about this improves by waiting. */
            true,
          ),
        );
        continue;
      }

      const message = await composeNotification(subject);

      await mailer.send({
        to: row.toEmail,
        subject: message.subject,
        html: message.html,
        text: message.text,
        calendar: message.calendar,
      });

      await markSent(db, row.id);

      outcomes.push({
        status: "sent",
        id: row.id,
        kind: row.kind,
        to: row.toEmail,
        detail: describeNotification(subject),
      });
    } catch (error) {
      outcomes.push(await markFailure(db, row, messageOf(error), false));
    }
  }

  return {
    claimed: claimed.length,
    sent: outcomes.filter((outcome) => outcome.status === "sent").length,
    retrying: outcomes.filter((outcome) => outcome.status === "retrying").length,
    failed: outcomes.filter((outcome) => outcome.status === "failed").length,
    mailer: mailer.name,
    outcomes,
  };
}
