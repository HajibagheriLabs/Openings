"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { BUSINESS_HINT_COOKIE } from "@/lib/auth-cookies";

/**
 * Sign out.
 *
 * A Server Action rather than a client call, for one reason: the session
 * cookie and the proxy's business hint have to go together. Leaving the hint
 * behind would send the next person to sign in on this browser straight into
 * an admin area belonging to a business they may not own — harmlessly, because
 * the page re-checks and bounces them, but visibly and confusingly.
 *
 * `auth.api.signOut` revokes the session row as well as clearing the cookie,
 * so a stolen token stops working rather than merely being forgotten locally.
 */
export async function signOutAction(): Promise<void> {
  await auth.api.signOut({ headers: await headers() });

  (await cookies()).delete(BUSINESS_HINT_COOKIE);

  redirect("/sign-in");
}
