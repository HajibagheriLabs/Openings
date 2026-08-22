import { NextResponse } from "next/server";

import { db } from "@/db";
import { releaseHoldByToken } from "@/lib/scheduling/booking";
import { clearHoldCookie, readHoldCookie } from "@/server/booking/hold-cookie";

/**
 * "I am leaving — have my slot back."
 *
 * A ROUTE HANDLER RATHER THAN A SERVER ACTION, for one reason:
 * `navigator.sendBeacon` is the only request a browser will reliably still
 * make while a page is being torn down, and it posts a plain body to a plain
 * URL. It cannot invoke a Server Action, which needs headers the beacon API
 * does not let you set. The cookie rides along because a beacon is a
 * same-origin POST and this cookie is SameSite=Lax.
 *
 * BEST EFFORT, AND NOTHING DEPENDS ON IT. A closed laptop, a killed tab, a
 * phone that lost signal in a lift, a browser that decided the page was going
 * away too fast — every one of those means this call never happens, and every
 * one of those is fine. The hold has a deadline written by Postgres, every
 * availability query already ignores a lapsed hold, and every booking
 * transaction deletes colliding expired holds before it writes. This endpoint
 * only makes the slot come back sooner than eight minutes; it is never what
 * makes it come back.
 *
 * It answers 204 whatever happened, including for a hold that is missing, has
 * already expired, or was never this browser's. There is nothing useful to say
 * to a page that has already gone, and a body would only be an oracle for
 * which appointment ids exist.
 */
export const runtime = "nodejs";

export async function POST(request: Request) {
  const slug = await readSlug(request);

  if (slug) {
    const cookie = await readHoldCookie(slug);

    if (cookie) {
      // Token-checked inside — an appointment id alone releases nothing.
      await releaseHoldByToken(db, cookie.appointmentId, cookie.manageToken);
    }
  }

  await clearHoldCookie();

  return new NextResponse(null, { status: 204 });
}

/**
 * The business the hold belongs to, from a beacon's body.
 *
 * A beacon sends a Blob, so this is parsed defensively: anything unreadable
 * means we simply clear the cookie and let expiry do the rest.
 */
async function readSlug(request: Request): Promise<string | null> {
  try {
    const body: unknown = await request.json();

    return typeof body === "object" &&
      body !== null &&
      typeof (body as { slug?: unknown }).slug === "string"
      ? (body as { slug: string }).slug
      : null;
  } catch {
    return null;
  }
}
