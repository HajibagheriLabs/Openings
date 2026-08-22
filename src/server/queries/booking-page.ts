import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { businesses } from "@/db/schema";

/**
 * What the PUBLIC booking page is allowed to know about a business.
 *
 * An explicit column list rather than `select()`, because this row is rendered
 * to anybody on the internet who guesses a slug. `owner_user_id` is not a
 * secret worth much, but sending it to every visitor because the query was
 * lazy is the habit that eventually ships something that is. The page can only
 * leak what the loader hands it.
 */
export interface PublicBusiness {
  id: string;
  name: string;
  slug: string;
  /** One line under the name. Null when the owner has not written one. */
  description: string | null;
  /** Where to turn up. Null until it is filled in. */
  address: string | null;
  contactEmail: string;
  contactPhone: string | null;
  /** IANA identifier. Every time on the page is expressed in this zone. */
  timezone: string;
  currency: string;
  slotGranularityMin: number;
  minLeadTimeMin: number;
  maxAdvanceDays: number;
}

/**
 * A business by its public slug, or null.
 *
 * Null is a genuine 404 and the page treats it as one: there is no such
 * booking page. It is not an error state, an empty state or a redirect to
 * somewhere more useful — a mistyped address should say so and stop.
 */
export async function loadPublicBusiness(
  slug: string,
): Promise<PublicBusiness | null> {
  const [business] = await db
    .select({
      id: businesses.id,
      name: businesses.name,
      slug: businesses.slug,
      description: businesses.description,
      address: businesses.address,
      contactEmail: businesses.contactEmail,
      contactPhone: businesses.contactPhone,
      timezone: businesses.timezone,
      currency: businesses.currency,
      slotGranularityMin: businesses.slotGranularityMin,
      minLeadTimeMin: businesses.minLeadTimeMin,
      maxAdvanceDays: businesses.maxAdvanceDays,
    })
    .from(businesses)
    .where(eq(businesses.slug, slug))
    .limit(1);

  return business ?? null;
}
