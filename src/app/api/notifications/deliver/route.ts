import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/db";
import { DELIVERY_PATH } from "@/lib/notifications/scheduler";
import { drainNotifications } from "@/lib/notifications/worker";
import { isSignedByScheduler } from "@/server/scheduled/authorize";

/**
 * One scheduled reminder, arriving at its exact moment.
 *
 * THIS IS THE MECHANISM. When a booking is confirmed, a message is published
 * to Upstash QStash with a `notBefore` of the reminder's instant, addressed
 * here and carrying the notification id. QStash calls this route at that
 * minute. See the long note at the top of src/lib/notifications/scheduler.ts
 * for why a daily cron cannot do this job.
 *
 * THE SIGNATURE IS THE ONLY CREDENTIAL. This URL is public and its body names
 * a row, so a shared secret would not be enough: the signature proves both
 * that QStash sent the request and that the body is the one we published. An
 * unsigned request cannot ask this route to send anything.
 *
 * NOTHING SPECIAL HAPPENS TO A SCHEDULED MESSAGE. It goes through the same
 * claim, the same lease, the same liveness check and the same backoff as a row
 * the daily sweep picked up — see `drainNotifications`. A message must not
 * behave differently depending on who noticed it was due, or the two paths
 * drift and only one of them gets tested.
 */
export const runtime = "nodejs";

/* Never cached, never prerendered. */
export const dynamic = "force-dynamic";

const payloadSchema = z.object({ notificationId: z.uuid() });

export async function POST(request: Request) {
  /* The RAW body. The signature is computed over exact bytes, and parsing then
     re-serialising them would produce something no longer byte-identical. */
  const body = await request.text();

  if (!(await isSignedByScheduler(request, body, DELIVERY_PATH))) {
    /**
     * 401 rather than 500, because retrying will not help. QStash gives up on
     * a 4xx, which is what should happen to a request we cannot authenticate.
     */
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = payloadSchema.safeParse(safeJson(body));

  if (!parsed.success) {
    /* We published this body ourselves, so a malformed one is a bug rather
       than an attack — but retrying it would still never succeed. */
    console.error("[delivery] a signed message carried no notification id");

    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }

  try {
    const result = await drainNotifications(db, {
      notificationId: parsed.data.notificationId,
      limit: 1,
    });

    /**
     * 200 FOR EVERY OUTCOME THAT WILL NOT IMPROVE ON RETRY — which is all of
     * them except a thrown error.
     *
     * `claimed: 0` is the ordinary case for a message that arrives after the
     * daily catch-up already sent the row, or after the appointment was
     * cancelled and the row withdrawn. Answering 4xx or 5xx there would earn
     * three retries against a row that is deliberately gone.
     */
    if (result.claimed === 0) {
      return NextResponse.json({ claimed: 0, note: "nothing pending" });
    }

    console.info(
      `[delivery] scheduled message for ${parsed.data.notificationId} via ${result.mailer}: ` +
        `${result.sent} sent, ${result.retrying} retrying, ${result.failed} failed, ` +
        `${result.cancelled} withdrawn.`,
    );

    return NextResponse.json({
      claimed: result.claimed,
      sent: result.sent,
      retrying: result.retrying,
      failed: result.failed,
      cancelled: result.cancelled,
      mailer: result.mailer,
    });
  } catch (error) {
    /**
     * The database went away. 500 is deliberate: QStash retries, the row is
     * still `pending`, and its claim lease means the next attempt picks up
     * exactly where this one stopped. If every retry fails, the daily catch-up
     * is still behind it.
     */
    console.error("[delivery] a scheduled delivery failed", error);

    return NextResponse.json({ error: "delivery failed" }, { status: 500 });
  }
}

/** A body we published ourselves, so a parse failure is a bug, not a branch. */
function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
