import { and, eq } from "drizzle-orm";
import type { Metadata } from "next";
import { CalendarDays } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { db } from "@/db";
import { services, staff } from "@/db/schema";
import {
  getOwnedBusiness,
  requireBusinessAccess,
  requireUser,
} from "@/lib/auth-server";

export const metadata: Metadata = {
  title: "Calendar",
};

/**
 * Placeholder — the week view lands here later.
 *
 * It does read `?service=` and `?staff=`, because the services and staff
 * screens refuse a delete by pointing at this page: "N appointments still to
 * come — show them". A link that landed on an unchanged empty state would make
 * that refusal look like a dead end, so the filter is at least acknowledged by
 * name until the grid exists to apply it to.
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ service?: string; staff?: string }>;
}) {
  const user = await requireUser("/admin/calendar");
  const owned = await getOwnedBusiness(user.id);
  const { business } = await requireBusinessAccess(owned!.id);

  const { service: serviceId, staff: staffId } = await searchParams;

  // Scoped to this business, so a foreign id names nothing rather than
  // confirming that a row with that id exists somewhere.
  const [service] = serviceId
    ? await db
        .select({ name: services.name })
        .from(services)
        .where(
          and(eq(services.id, serviceId), eq(services.businessId, business.id)),
        )
        .limit(1)
    : [];

  const [member] = staffId
    ? await db
        .select({ name: staff.name })
        .from(staff)
        .where(and(eq(staff.id, staffId), eq(staff.businessId, business.id)))
        .limit(1)
    : [];

  const filter = service?.name ?? member?.name ?? null;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Calendar"
        title="The week ahead"
        description="The same Ribbon as Today, scrolled across a week instead of a day — same scale, same encoding, more columns."
      />

      <EmptyState
        icon={CalendarDays}
        title={filter ? `No calendar yet — you asked for ${filter}` : "No calendar yet"}
        description={
          filter
            ? `This is where the week view lands, and where a filter for ${filter} will apply. The appointments it would show already exist; there is just nothing here yet to draw them on.`
            : "This is where the week view lands. It reuses the Ribbon component, so a 90-minute appointment will occupy three times a 30-minute one here too."
        }
      />
    </div>
  );
}
