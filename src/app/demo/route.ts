import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db";
import { businesses, users } from "@/db/schema";
import { serverEnv } from "@/env";
import { auth } from "@/lib/auth";
import {
  BUSINESS_HINT_COOKIE,
  BUSINESS_HINT_MAX_AGE_SECONDS,
} from "@/lib/auth-cookies";

/**
 * One click into the owner area.
 *
 * ═══ IT SIGNS IN PROPERLY ═══
 *
 * This does not forge a session, stamp a cookie by hand, or add a back door to
 * the auth configuration. It calls `signInEmail` with the seeded demo owner's
 * real credentials and forwards the `Set-Cookie` Better Auth issues — the same
 * request the sign-in form makes, with the password filled in from the server's
 * own configuration instead of by a person. A demo that authenticated
 * differently from the product would be demonstrating something the product
 * does not do, and it would be the one code path nobody tests.
 *
 * ═══ WHY A GET, WHEN IT HAS A SIDE EFFECT ═══
 *
 * Because the thing that has to work is a link — in a CV, in an email, on a
 * portfolio page — and a link is a GET. The side effect is a session for an
 * account whose credentials are published on the landing page, so there is
 * nothing here for a prefetching browser or a link scanner to damage: the worst
 * a stray request can do is issue a cookie to something that will not use it.
 *
 * ═══ IT NEVER 500s ═══
 *
 * A clone that has not been seeded has no demo owner, and a deployment that has
 * not set DEMO_OWNER_PASSWORD cannot sign one in. Both are ordinary states, not
 * faults, and both send the visitor back to the landing page with a note rather
 * than to a stack trace.
 */
export const runtime = "nodejs";

/* Never cached, never prerendered — it issues a session cookie. */
export const dynamic = "force-dynamic";

/** Where an unavailable demo sends people, and what the page says when it does. */
const UNAVAILABLE = "/?demo=unavailable";

export async function GET(request: Request) {
  const email = serverEnv.DEMO_OWNER_EMAIL;
  const password = serverEnv.DEMO_OWNER_PASSWORD;

  if (!email || !password) {
    return NextResponse.redirect(new URL(UNAVAILABLE, request.url));
  }

  /**
   * The demo owner's business, resolved BEFORE signing in.
   *
   * Two things come out of it: whether there is a demo to enter at all, and
   * the business hint the proxy reads to decide that /admin is worth
   * rendering. Without the hint the proxy bounces the visitor to /onboarding,
   * where they would be invited to create a business they do not want.
   */
  const [demo] = await db
    .select({ slug: businesses.slug, isDemo: businesses.isDemo })
    .from(businesses)
    .innerJoin(users, eq(users.id, businesses.ownerUserId))
    .where(eq(users.email, email))
    .limit(1);

  if (!demo?.isDemo) {
    return NextResponse.redirect(new URL(UNAVAILABLE, request.url));
  }

  let signIn: Response;

  try {
    /* `asResponse` so the Set-Cookie header Better Auth issues can be copied
       onto the redirect verbatim, rather than reconstructed. */
    signIn = await auth.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
  } catch (error) {
    console.error("[demo] the demo owner could not be signed in", error);

    return NextResponse.redirect(new URL(UNAVAILABLE, request.url));
  }

  if (!signIn.ok) {
    /* Almost always a DEMO_OWNER_PASSWORD that no longer matches what the seed
       wrote. Re-running `npm run db:seed` rewrites the credential. */
    console.error(
      `[demo] sign-in refused (${signIn.status}). Re-run npm run db:seed after ` +
        "changing DEMO_OWNER_PASSWORD.",
    );

    return NextResponse.redirect(new URL(UNAVAILABLE, request.url));
  }

  /* Straight to the agenda for today, which is where an owner's morning
     starts and the most convincing thing to arrive at. */
  const response = NextResponse.redirect(new URL("/admin", request.url));

  for (const cookie of signIn.headers.getSetCookie()) {
    response.headers.append("set-cookie", cookie);
  }

  /* The proxy's hint, in the same shape /api/session/sync writes it: the
     slug, and deliberately readable by script, because it is a hint rather
     than a credential and marking it httpOnly would imply it protects
     something. Every page re-checks ownership on the server regardless — but
     without it the first navigation to /admin is a detour to /onboarding. */
  response.cookies.set(BUSINESS_HINT_COOKIE, demo.slug, {
    path: "/",
    sameSite: "lax",
    maxAge: BUSINESS_HINT_MAX_AGE_SECONDS,
    httpOnly: false,
    secure: serverEnv.BETTER_AUTH_URL.startsWith("https://"),
  });

  return response;
}
