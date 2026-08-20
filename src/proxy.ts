import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

import { AUTH_COOKIE_PREFIX, BUSINESS_HINT_COOKIE } from "@/lib/auth-cookies";

/* ===========================================================================
   THIS IS NOT A SECURITY BOUNDARY.
   ---------------------------------------------------------------------------
   Everything below is redirect UX: it saves a signed-out visitor from watching
   an admin page render and then bounce, and it saves a half-set-up owner from
   landing on an empty agenda. It decides nothing.

   It cannot decide anything, and that is by design:
     - It only looks at whether a session COOKIE EXISTS. It does not verify the
       signature, does not load the session, and does not know whether that
       session was revoked five minutes ago. Verifying would mean a database
       round trip on every navigation, at the edge, where the connection pool
       does not live.
     - The business hint cookie it reads is a plain, forgeable string.

   So every page, layout, Server Action and route handler re-checks on the
   server through `@/lib/auth-server` — `requireUser()` for a session and
   `requireBusinessAccess()` for ownership. Deleting this file would cost some
   flicker and cost NOTHING in access control. If you ever find yourself
   tempted to let a route skip its own check "because the proxy handles it",
   the answer is no.
   =========================================================================== */

/** Routes that require a signed-in owner. */
const OWNER_ROUTES = ["/admin", "/onboarding"];

/**
 * Pages that make no sense while signed in.
 *
 * /forgot-password and /reset-password are deliberately NOT here. Someone can
 * hold a valid session and still be following a reset link from their inbox,
 * and bouncing them to /admin would strand them mid-recovery.
 */
const GUEST_ROUTES = ["/sign-in", "/sign-up"];

const isWithin = (pathname: string, routes: string[]) =>
  routes.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );

export default function proxy(request: NextRequest) {
  const { nextUrl } = request;
  const { pathname } = nextUrl;

  // Presence only — see the note above. `getSessionCookie` reads the cookie
  // jar and nothing else, which is exactly what makes it safe to run here.
  const hasSession = Boolean(
    getSessionCookie(request, { cookiePrefix: AUTH_COOKIE_PREFIX }),
  );

  if (isWithin(pathname, OWNER_ROUTES)) {
    if (!hasSession) {
      const signIn = new URL("/sign-in", nextUrl);
      // Carry the destination so signing in lands where they were headed.
      signIn.searchParams.set("next", `${pathname}${nextUrl.search}`);
      return NextResponse.redirect(signIn);
    }

    /**
     * An owner who has not created a business has nothing to look at in the
     * admin area, so send them to finish setting up.
     *
     * The hint cookie is how this is known without a query. When it is missing
     * but a business does exist — a cleared cookie, a different browser — the
     * /onboarding page hands off to /api/session/sync, which reads the truth
     * from the database, rewrites the hint and continues. That handoff is what
     * keeps this from becoming an /admin ⇄ /onboarding loop, because a Server
     * Component cannot write a cookie and a route handler can.
     */
    const hasBusinessHint = Boolean(
      request.cookies.get(BUSINESS_HINT_COOKIE)?.value,
    );

    if (!hasBusinessHint && isWithin(pathname, ["/admin"])) {
      return NextResponse.redirect(new URL("/onboarding", nextUrl));
    }
  }

  if (hasSession && isWithin(pathname, GUEST_ROUTES)) {
    return NextResponse.redirect(new URL("/admin", nextUrl));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/admin/:path*",
    "/onboarding/:path*",
    "/sign-in",
    "/sign-up",
  ],
};
