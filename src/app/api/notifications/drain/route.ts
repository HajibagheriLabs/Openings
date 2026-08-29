import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { db } from "@/db";
import { serverEnv } from "@/env";
import { drainNotifications, DEFAULT_BATCH } from "@/lib/notifications/worker";

/**
 * Drain the outbox.
 *
 * The worker itself is a plain function (src/lib/notifications/worker.ts); this
 * is the door into it. Two callers are expected, and both arrive with the same
 * shared secret:
 *
 *   - Upstash QStash, one call per booking, scheduled for the moment a reminder
 *     is due.
 *   - The daily Vercel cron, as the safety net that catches anything QStash
 *     never delivered — a token that expired, a queue that was paused, a
 *     booking made while QStash was unreachable.
 *
 * Both land in the next step. The route exists now, with its own tests, so that
 * step is wiring rather than invention.
 *
 * WHY POST. Draining is not idempotent in the HTTP sense — it sends email — and
 * a GET is exactly the sort of thing a link checker, a prefetch or a browser
 * preview will follow on its own.
 */
export const runtime = "nodejs";

/* Never cached, never prerendered. */
export const dynamic = "force-dynamic";

/**
 * Constant-time comparison against the configured secret.
 *
 * `===` would leak, through timing, how many leading characters a guess got
 * right. The endpoint is unauthenticated apart from this string, so it is worth
 * the two lines. Lengths are compared first because `timingSafeEqual` throws on
 * a mismatch — that comparison leaks only the length, which is not a secret.
 */
function presentsSecret(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : header;

  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(secret, "utf8");

  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const secret = serverEnv.CRON_SECRET;

  if (!secret) {
    /**
     * NOT CONFIGURED.
     *
     * In production this endpoint stays shut: an open drain is an open "send
     * every queued email now" button, and a deploy that forgot the variable
     * should fail loudly rather than run unprotected.
     *
     * In development it runs, and says so. The whole product is meant to work
     * on a laptop with nothing but a database — the console mailer exists for
     * exactly that — and requiring a secret to see your own confirmation email
     * printed to your own terminal would defeat the point.
     */
    if (serverEnv.NODE_ENV === "production") {
      console.error(
        "[notifications] drain was called but CRON_SECRET is not set. " +
          "Refusing: this endpoint sends email and will not run unprotected.",
      );

      return NextResponse.json({ error: "not configured" }, { status: 503 });
    }

    console.warn(
      "[notifications] draining WITHOUT a shared secret. CRON_SECRET is not " +
        "set, which is allowed in development only.",
    );
  } else if (!presentsSecret(request, secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  /* An optional batch size, so the daily catch-up can ask for more than a
     single reminder call does. Anything unparseable is simply the default. */
  const requested = Number(new URL(request.url).searchParams.get("limit"));
  const limit =
    Number.isInteger(requested) && requested > 0 && requested <= 200
      ? requested
      : DEFAULT_BATCH;

  try {
    const result = await drainNotifications(db, { limit });

    if (result.claimed > 0) {
      console.info(
        `[notifications] drained ${result.claimed} via ${result.mailer}: ` +
          `${result.sent} sent, ${result.retrying} retrying, ${result.failed} failed.`,
      );
    }

    return NextResponse.json({
      claimed: result.claimed,
      sent: result.sent,
      retrying: result.retrying,
      failed: result.failed,
      mailer: result.mailer,
    });
  } catch (error) {
    /**
     * The drain itself fell over — the database went away, most likely.
     * Individual message failures never reach here; they are recorded on their
     * own rows and reported in the body above.
     *
     * 500 is deliberate: both callers retry, and every claimed row is already
     * leased rather than lost, so the next run picks up exactly where this one
     * stopped.
     */
    console.error("[notifications] the drain failed", error);

    return NextResponse.json({ error: "drain failed" }, { status: 500 });
  }
}
