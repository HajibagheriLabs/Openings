import "server-only";

import { sql } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import type { Business } from "@/db/schema";

/**
 * What the demo workspace will not let you do.
 *
 * ═══ TWO LAYERS, AND THEY ARE NOT REDUNDANT ═══
 *
 * The refusals below are the FRIENDLY layer. They return a sentence the owner
 * area can put in a toast, naming what was refused and why, before anything is
 * attempted.
 *
 * The REAL arbiter is a pair of database triggers (migration 0013). They refuse
 * the same operations with a `check_violation`, and they cannot be forgotten by
 * a Server Action written next month. This is the same division of labour as
 * the no-overlap exclusion constraint: the database decides, and the
 * application check exists to produce a better error message than the
 * database's.
 *
 * ═══ WHAT IS DELIBERATELY STILL ALLOWED ═══
 *
 * Booking, cancelling, marking a no-show, writing notes, blocking time and
 * undoing it, editing hours and services, taking a real Stripe test payment.
 * All of it. A demonstration a visitor cannot change is a screenshot, and the
 * whole point of this one is that the concurrency and the timezone handling are
 * real. What is protected is only the scenery: the two businesses, their
 * staff, their services, their customers, and the timezone that makes the
 * demonstration mean anything.
 */

/**
 * Fields a demo business keeps for life, named here so the copy on the
 * settings screen and the trigger in migration 0013 describe one rule.
 *
 * THERE IS NO APPLICATION GUARD FOR THESE, on purpose. Nothing in the product
 * can change them today — there is no business-details form yet — so a
 * refusal function would be an uncalled branch pretending to be a safeguard.
 * The trigger is the enforcement, it covers direct SQL as well as any action
 * written later, and `test/demo.integration.test.ts` proves it refuses. When
 * the settings form lands, the friendly sentence goes with it.
 */
export const DEMO_FIXED_FIELDS = ["timezone", "slug", "currency"] as const;

/** The shape every owner action already returns for a refusal. */
export interface DemoRefusal {
  ok: false;
  message: string;
}

/**
 * Refuse a deletion in the demo workspace, or return null to carry on.
 *
 * `subject` is named in the sentence — "services", "staff" — because a refusal
 * that does not say what it refused reads as a bug.
 */
export function refuseDemoDelete(
  business: Pick<Business, "isDemo">,
  subject: string,
): DemoRefusal | null {
  if (!business.isDemo) {
    return null;
  }

  return {
    ok: false,
    message:
      `This is the demo workspace, so ${subject} cannot be deleted — the next ` +
      "visitor needs them. Everything else works: book, cancel, block out time, " +
      "mark a no-show.",
  };
}

/**
 * Why the fixed fields are fixed, in the words the settings screen uses.
 *
 * THE TIMEZONE IS THE ONE THAT MATTERS. Two businesses in two zones is the
 * thing this demo exists to show, and re-zoning one would silently change what
 * every appointment already on its calendar means.
 */
export const DEMO_FIXED_FIELDS_REASON =
  "The demo keeps its timezone, address and currency — two businesses in two " +
  "timezones is what it is here to show, and re-zoning one would quietly move " +
  "every appointment already on its calendar.";

/**
 * Run a block with the demo triggers stood down.
 *
 * ONLY TWO CALLERS, both of them ours and both of them documented: the seed
 * script, which has to tear the previous demo down before it can build the
 * next one, and the nightly tidy-up, which clears bookings visitors left
 * behind. Anything else calling this is a bug.
 *
 * `SET LOCAL` scopes the setting to the surrounding transaction, so it is
 * released on commit or rollback and can never leak onto a pooled connection
 * that a request later picks up.
 */
export async function withDemoBypass<T>(
  tx: DbOrTx,
  run: () => Promise<T>,
): Promise<T> {
  await tx.execute(sql`SET LOCAL openings.demo_bypass = 'on'`);

  return run();
}
