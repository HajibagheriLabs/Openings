import { NextResponse, type NextRequest } from "next/server";

import {
  BUSINESS_HINT_COOKIE,
  BUSINESS_HINT_MAX_AGE_SECONDS,
} from "@/lib/auth-cookies";
import { getOwnedBusiness, getUser } from "@/lib/auth-server";

/**
 * Repairs the business hint cookie the proxy reads, then continues.
 *
 * Why this route exists at all: the proxy sends an owner with no hint cookie
 * to /onboarding. When the hint is merely missing — cleared cookies, a second
 * browser, a session that outlived the hint — /onboarding finds a real
 * business in the database and needs to send them back to /admin. It cannot
 * fix the cookie itself, because a Server Component may not write one, so
 * /admin would bounce straight back and the two pages would ping-pong.
 *
 * A route handler CAN write a cookie. This one reads the truth from the
 * database, writes the hint to match, and redirects onwards. One extra hop,
 * once, and the loop is gone.
 *
 * It grants nothing. The cookie it writes is a hint the proxy uses to skip a
 * redirect; every route still checks ownership server-side.
 */
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const user = await getUser();

  if (!user) {
    return NextResponse.redirect(new URL("/sign-in", request.nextUrl));
  }

  /**
   * Only same-origin, absolute-path destinations. Taking the raw `to` value
   * would make this an open redirect: anyone could mail an owner a link to
   * /api/session/sync?to=https://example.invalid and have our own domain
   * forward them there.
   */
  const requested = request.nextUrl.searchParams.get("to") ?? "/admin";
  const destination =
    requested.startsWith("/") && !requested.startsWith("//")
      ? requested
      : "/admin";

  const business = await getOwnedBusiness(user.id);

  const response = NextResponse.redirect(
    new URL(business ? destination : "/onboarding", request.nextUrl),
  );

  if (business) {
    response.cookies.set(BUSINESS_HINT_COOKIE, business.slug, {
      path: "/",
      sameSite: "lax",
      maxAge: BUSINESS_HINT_MAX_AGE_SECONDS,
      // Deliberately readable by script: it is a hint, not a credential, and
      // marking it httpOnly would imply it protects something. It does not.
      httpOnly: false,
      secure: request.nextUrl.protocol === "https:",
    });
  } else {
    response.cookies.delete(BUSINESS_HINT_COOKIE);
  }

  return response;
}
