import "server-only";

import { cookies } from "next/headers";

import { DEFAULT_HOLD_MINUTES } from "@/lib/scheduling/booking";

/**
 * Where the customer's hold lives between requests.
 *
 * WHY A COOKIE AND NOT sessionStorage. The booking page is a Server Component
 * that decides which step to render and what the day looks like. A hold kept
 * in the browser's storage would be invisible to that render, so a refresh
 * would paint the customer's own slot as taken by a stranger and then correct
 * itself a moment later — on the one screen where a slot flickering from
 * "yours" to "gone" is the worst thing that can happen. A cookie arrives with
 * the request, so the first paint after a reload is already right.
 *
 * WHY httpOnly. The value contains the appointment's manage token, which is
 * the customer's proof that the appointment is theirs. Nothing in the browser
 * needs to read it — every use of it happens on the server — so no script
 * should be able to, including one that gets injected.
 *
 * WHY IT IS NOT A SECURITY BOUNDARY BY ITSELF. Losing this cookie loses the
 * customer the ability to release or move their hold early. It does not lose
 * them the slot, and it does not leak the slot to anybody else: the hold
 * expires on the database's clock either way. The cookie is a convenience over
 * a fact that lives in Postgres.
 */

export const HOLD_COOKIE = "openings_hold";

export interface HoldCookie {
  appointmentId: string;
  /** Plaintext manage token. The row stores only its SHA-256. */
  manageToken: string;
  /** The business the hold belongs to, so one shop's cookie is not read at another. */
  slug: string;
}

/**
 * The cookie outlives the hold by a minute.
 *
 * Deliberately not exactly the hold length: the row is the authority on when
 * the hold ends, and a cookie that expired a second early would leave a live
 * hold with nothing able to release it. Overshooting costs nothing — the
 * server checks the row, finds it gone, and says so.
 */
const COOKIE_MAX_AGE_SECONDS = (DEFAULT_HOLD_MINUTES + 1) * 60;

function encode(value: HoldCookie): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(raw: string): HoldCookie | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as HoldCookie).appointmentId !== "string" ||
      typeof (parsed as HoldCookie).manageToken !== "string" ||
      typeof (parsed as HoldCookie).slug !== "string"
    ) {
      return null;
    }

    return parsed as HoldCookie;
  } catch {
    // A truncated or hand-edited cookie is simply no hold. Never an error page.
    return null;
  }
}

/**
 * The hold for one business, or null.
 *
 * The slug has to match: a cookie written at one shop must not make a hold
 * appear at another, and without the check a stale cookie would send an
 * appointment id from Rosa's into a query scoped to somebody else's business.
 */
export async function readHoldCookie(slug: string): Promise<HoldCookie | null> {
  const raw = (await cookies()).get(HOLD_COOKIE)?.value;
  const value = raw ? decode(raw) : null;

  return value && value.slug === slug ? value : null;
}

/**
 * Only callable from a Server Action or a Route Handler.
 *
 * `maxAgeSeconds` exists for the one moment the cookie changes meaning: once
 * the appointment is confirmed it stops being "the slot I am holding for eight
 * minutes" and becomes "the appointment this browser just made", which has to
 * outlive a refresh by rather more than eight minutes. The value inside is
 * identical either way — the row's status is what says which it is.
 */
export async function writeHoldCookie(
  value: HoldCookie,
  maxAgeSeconds: number = COOKIE_MAX_AGE_SECONDS,
): Promise<void> {
  (await cookies()).set(HOLD_COOKIE, encode(value), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

export async function clearHoldCookie(): Promise<void> {
  (await cookies()).delete(HOLD_COOKIE);
}
