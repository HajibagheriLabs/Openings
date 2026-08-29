import { NextResponse } from "next/server";

import { db } from "@/db";
import { countScheduled, countUnscheduled } from "@/lib/notifications/delivery";
import { drainNotifications } from "@/lib/notifications/worker";
import { reclaimExpiredHolds } from "@/lib/scheduling/booking";
import { forgetIdleRateLimits } from "@/server/booking/rate-limit";
import { tidyDemoBookings } from "@/server/demo/tidy";
import { forgetOldWebhookEvents } from "@/server/payments/webhook";
import { authorizeCron, isSignedByScheduler } from "@/server/scheduled/authorize";

/**
 * ═══ A NET, NOT THE MECHANISM ═══
 *
 * CORRECTNESS DOES NOT DEPEND ON THIS JOB RUNNING. If it were deleted tomorrow
 * the product would still never double-book, still never show an expired hold
 * as unavailable, and still deliver every reminder on time — because:
 *
 *   - reminders are scheduled individually, per booking, for their exact
 *     minute (src/lib/notifications/scheduler.ts);
 *   - every booking transaction clears colliding expired holds before it
 *     writes, and every availability query treats a lapsed hold as free, so
 *     the janitor below only reclaims rows (`reclaimExpiredHolds`);
 *   - the outbox row is the source of truth for every message, and it survives
 *     anything that happens to a scheduled delivery.
 *
 * What this job catches is the gap between those guarantees and reality: a
 * QStash publish that failed while the booking still committed, a token that
 * expired, a queue that was paused, an appointment booked while the delivery
 * service was unreachable, a message the service dropped. Each of those leaves
 * a pending outbox row that nothing is coming for. This finds them.
 *
 * ═══ AND IT IS THE WHOLE MECHANISM WITH NO QSTASH ═══
 *
 * With no QSTASH_TOKEN — a reviewer who cloned the repository, a deploy that
 * has not set it up yet — nothing is ever scheduled and every message waits
 * for this sweep. That is late, by up to a day, and it is never wrong. The
 * admin area says which mode is running rather than leaving it to be guessed.
 *
 * ═══ WHY ONCE A DAY, AND WHY THAT IS NOT ENOUGH ON ITS OWN ═══
 *
 * A Vercel Hobby project may run AT MOST ONE CRON PER DAY, and the schedule is
 * approximate: a job declared for 09:00 fires somewhere inside that hour. So a
 * sweep cannot be the reminder mechanism — "24 hours before the appointment"
 * has a resolution of minutes and this job has a resolution of a day. It is
 * exactly the wrong tool for the primary path and exactly the right one for a
 * backstop, which is why it is used as the second and not the first.
 */
export const runtime = "nodejs";

/* Never cached, never prerendered. */
export const dynamic = "force-dynamic";

/** The route's own path, for verifying a scheduler signature against it. */
const CRON_PATH = "/api/cron/daily";

/**
 * A bigger bite than a single delivery takes.
 *
 * This is a catch-up: if a token expired a week ago there is a backlog, and
 * twenty-five rows a day would take a month to clear it. Two hundred still
 * finishes comfortably inside a serverless invocation, and anything left over
 * is picked up by tomorrow's run — or, far more likely, by the scheduled
 * deliveries that resume the moment the configuration is fixed.
 */
const CATCH_UP_BATCH = 200;

export async function POST(request: Request) {
  return run(request);
}

/**
 * Vercel's cron scheduler issues a GET.
 *
 * Both verbs are accepted and both land in the same function, because the
 * alternative is a job that silently does nothing and reports success. The
 * authorization is identical, so the extra verb costs no surface.
 */
export async function GET(request: Request) {
  return run(request);
}

async function run(request: Request) {
  /* The raw body, read once, because a signature is computed over exact bytes.
     A cron GET has none, which is fine — it authenticates with the bearer. */
  const body = await request.text().catch(() => "");

  const caller = authorizeCron(request);

  if (!caller.allowed) {
    /* The delivery service is the other legitimate caller: a QStash schedule
       may be pointed here instead of, or alongside, the Vercel cron. Its
       signature is checked only after the bearer has failed, so the ordinary
       path costs nothing. */
    if (!(await isSignedByScheduler(request, body, CRON_PATH))) {
      if (caller.status === 503) {
        console.error(`[cron] ${caller.reason}`);
      }

      return NextResponse.json(
        { error: caller.reason },
        { status: caller.status },
      );
    }
  } else if (caller.via === "development") {
    console.warn(
      "[cron] running WITHOUT a shared secret. CRON_SECRET is not set, " +
        "which is allowed in development only.",
    );
  }

  try {
    /**
     * ORDER MATTERS, a little.
     *
     * The outbox first, because it is the part somebody is waiting on. The
     * janitor after, because reclaiming a lapsed hold can only ever delete or
     * cancel rows that block nothing — nobody is waiting on it, and if this
     * invocation runs out of time the messages have already gone.
     */
    const outbox = await drainNotifications(db, { limit: CATCH_UP_BATCH });
    const holds = await reclaimExpiredHolds(db);
    const events = await forgetOldWebhookEvents();
    /* Rate-limit rows for subjects that have gone quiet. Nothing depends on
       this: a stale row is reset in place by the next request from that
       subject, so it only stops the table remembering every address that ever
       visited a manage link. */
    const limits = await forgetIdleRateLimits(db);
    /* And the demo workspace, if this deployment has one. Bookings visitors
       left behind more than a day ago go; the seeded fortnight stays, or the
       first sweep would empty the calendar it exists to keep presentable. */
    const demoBookings = await tidyDemoBookings(db);

    /* What the sweep is still carrying versus what has a delivery booked. The
       first number growing is the signal that scheduling is broken. */
    const unscheduled = await countUnscheduled(db);
    const scheduled = await countScheduled(db);

    const summary = {
      outbox: {
        claimed: outbox.claimed,
        sent: outbox.sent,
        retrying: outbox.retrying,
        failed: outbox.failed,
        cancelled: outbox.cancelled,
        mailer: outbox.mailer,
      },
      /** Lapsed holds deleted or cancelled. Housekeeping, never correctness. */
      holdsReclaimed: holds,
      /** Stripe event ids older than the retry window. */
      webhookEventsForgotten: events,
      /** Idle rate-limit counters. */
      rateLimitsForgotten: limits,
      /** Test bookings cleared out of the demo workspace. Always 0 without one. */
      demoBookingsCleared: demoBookings,
      pending: { scheduled, awaitingCatchUp: unscheduled },
    };

    if (outbox.claimed > 0 || holds > 0 || demoBookings > 0) {
      console.info(`[cron] daily sweep: ${JSON.stringify(summary)}`);
    }

    return NextResponse.json(summary);
  } catch (error) {
    /**
     * 500, and it is safe to retry: every claimed row is leased rather than
     * lost, so tomorrow's run — or a manual call — picks up exactly where this
     * one stopped.
     */
    console.error("[cron] the daily sweep failed", error);

    return NextResponse.json({ error: "sweep failed" }, { status: 500 });
  }
}
