import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DayPicker } from "@/components/booking/day-picker";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { buildBookingDemoDay } from "@/lib/demo/ribbon-demo";
import { loadBookableServices } from "@/server/queries/catalog";

/**
 * The customer's booking page. Public — no session, no account, ever.
 *
 * The slot list is STATIC DEMO DATA for now; picking a time writes nothing and
 * holds nothing. What is already real is the shape: the business and its
 * timezone come from the database, the day is resolved on the server in that
 * zone, and the client is handed instants it only formats.
 */

async function loadBusiness(slug: string) {
  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.slug, slug))
    .limit(1);

  return business ?? null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const business = await loadBusiness(slug);

  return { title: business ? `Book at ${business.name}` : "Not found" };
}

export default async function BookingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const business = await loadBusiness(slug);

  if (!business) {
    notFound();
  }

  /**
   * BOOKABLE, not merely active.
   *
   * The same predicate the admin's services list flags with — one function, so
   * what the owner is told and what the customer is shown cannot drift apart.
   * An active service with nobody active assigned to it must not reach this
   * page: the availability algorithm would have no staff to expand hours for
   * and would render an empty day with no explanation.
   */
  const bookable = await loadBookableServices(
    business.id,
    business.slotGranularityMin,
  );

  const service = bookable[0];

  if (!service) {
    notFound();
  }

  const day = buildBookingDemoDay(business.timezone, service.durationMin);

  /**
   * The picker owns the shell rather than sitting inside one.
   *
   * The sticky summary at the bottom shows the CHOSEN time, and the choice is
   * client state — so the component that holds the selection has to be the one
   * that fills that slot.
   */
  return (
    <DayPicker
      business={{
        name: business.name,
        timezone: business.timezone,
        currency: business.currency,
      }}
      service={{
        name: service.name,
        durationMin: service.durationMin,
        priceCents: service.priceCents,
      }}
      day={day}
    />
  );
}
