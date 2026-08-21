import { asc, eq } from "drizzle-orm";
import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { RibbonLegend } from "@/components/ribbon";
import { AgendaRibbon } from "@/components/admin/agenda-ribbon";
import { formatInstantDate } from "@/components/time-text";
import { db } from "@/db";
import { staff } from "@/db/schema";
import {
  getOwnedBusiness,
  requireBusinessAccess,
  requireUser,
} from "@/lib/auth-server";
import { buildAdminDemoDay } from "@/lib/demo/ribbon-demo";

export const metadata: Metadata = {
  title: "Today",
};

/**
 * The agenda: the Ribbon with one column per staff member.
 *
 * The segments below are STATIC DEMO DATA from src/lib/demo — there is no
 * availability algorithm yet and this page invents nothing about real
 * bookings. What is real is the shape of the contract: the server resolves the
 * day in the business's timezone and hands the component minutes and instants,
 * and the component draws them. Swapping the demo builder for
 * src/lib/scheduling later changes this file and nothing inside the ribbon.
 */
export default async function AdminTodayPage() {
  const user = await requireUser("/admin");
  const owned = await getOwnedBusiness(user.id);

  /**
   * Re-resolved through `requireBusinessAccess` rather than trusted from the
   * layout. It is the function every owner route uses, and using it here too
   * keeps that habit unbroken — a page that reads a business without asking
   * whether the caller owns it is exactly the page that eventually takes a
   * slug from the URL.
   */
  const { business } = await requireBusinessAccess(owned!.id);

  const team = await db
    .select()
    .from(staff)
    .where(eq(staff.businessId, business.id))
    .orderBy(asc(staff.displayOrder));

  const day = buildAdminDemoDay(
    business.timezone,
    team.map((member) => ({
      id: member.id,
      name: member.name,
      initials: member.initials,
    })),
  );

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Today"
        title={formatInstantDate(day.todayInstant, business.timezone)}
        description="Time is drawn to scale, so a 90-minute appointment takes up three times the space of a 30-minute one. Booked time is carved out of the day rather than stacked on top of it."
      />

      <AgendaRibbon
        window={day.window}
        columns={day.columns}
        timeZone={business.timezone}
        nowMinute={day.nowMinute}
      />

      <RibbonLegend
        states={["open", "held", "booked", "blocked"]}
        className="max-w-[46ch]"
      />
    </div>
  );
}
