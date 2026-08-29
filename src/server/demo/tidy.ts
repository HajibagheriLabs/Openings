import "server-only";

import { sql } from "drizzle-orm";

import type { Db } from "@/db/client";

import { withDemoBypass } from "./guard";

/**
 * Clearing up after the visitors.
 *
 * ═══ WHAT IT REMOVES, AND WHAT IT MUST NOT ═══
 *
 * A demo anybody can book into fills up. Left alone for a month it becomes a
 * wall of test bookings from strangers, the openings a new visitor needs are
 * gone, and the thing stops demonstrating anything. So bookings made in the
 * demo more than a day ago are deleted.
 *
 * THE SEEDED FORTNIGHT IS NOT TOUCHED, and getting that wrong would be worse
 * than not running at all: the first nightly sweep would empty the calendar it
 * exists to keep presentable. The two are told apart by the calendar identity
 * they were minted with — the seed's appointments carry an `ics_uid` in the
 * `openings.demo-seed` domain, a real fact about where the event came from
 * rather than a flag bolted on for this query.
 *
 * ═══ WHY A DAY ═══
 *
 * Long enough that somebody who books a slot and comes back after lunch still
 * finds it, and after a night's sleep still finds it. Short enough that the
 * demo is the shape the seed drew by the time the next person arrives.
 *
 * ═══ IT IS HOUSEKEEPING, NOT CORRECTNESS ═══
 *
 * Nothing depends on this running. A demo that has not been swept is a busier
 * demo, and that is all. Like the hold janitor next to it in the daily job, a
 * missed run is not an incident.
 */

/** How long a visitor's booking survives in the demo. */
export const DEMO_BOOKING_TTL_HOURS = 24;

/** The ics_uid domain the seed mints. Kept in step with scripts/seed.ts. */
export const SEED_ICS_DOMAIN = "openings.demo-seed";

/**
 * Delete demo bookings visitors left behind. Returns how many went.
 *
 * The delete is scoped by a join on `businesses.is_demo`, so it can only ever
 * reach a workspace that was explicitly marked as scenery — a real business is
 * not one predicate away from being swept.
 */
export async function tidyDemoBookings(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    /* The triggers from migration 0013 refuse deletes in a demo workspace.
       This is one of exactly two callers entitled to stand them down; the
       other is the seed. */
    return withDemoBypass(tx, async () => {
      const result = await tx.execute(sql`
        DELETE FROM appointments
         USING businesses
         WHERE businesses.id = appointments.business_id
           AND businesses.is_demo
           /* Scenery stays. See the note above on the seed's UID domain. */
           AND appointments.ics_uid NOT LIKE ${`%@${SEED_ICS_DOMAIN}`}
           AND appointments.created_at <
               now() - make_interval(hours => ${DEMO_BOOKING_TTL_HOURS}::int)
      `);

      return result.rowCount ?? 0;
    });
  });
}
