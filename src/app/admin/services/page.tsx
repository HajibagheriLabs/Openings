import type { Metadata } from "next";

import { ServicesManager } from "@/components/admin/services/services-manager";
import {
  getOwnedBusiness,
  requireBusinessAccess,
  requireUser,
} from "@/lib/auth-server";
import { loadServiceRows, loadStaffSummaries } from "@/server/queries/catalog";

export const metadata: Metadata = {
  title: "Services",
};

/**
 * The services screen.
 *
 * Reads on the server, mutates through Server Actions, and hands the client
 * plain data. Bookability is COMPUTED HERE, from the same predicate the public
 * booking page uses — the flag an owner sees and the decision a customer's
 * page makes are one function, so they cannot disagree.
 */
export default async function ServicesPage() {
  const user = await requireUser("/admin/services");
  const owned = await getOwnedBusiness(user.id);

  // Re-resolved rather than trusted from the layout, like every owner route.
  const { business } = await requireBusinessAccess(owned!.id);

  const [services, staff] = await Promise.all([
    loadServiceRows(business.id, business.slotGranularityMin),
    loadStaffSummaries(business.id),
  ]);

  return (
    <ServicesManager
      services={services}
      staff={staff}
      currency={business.currency}
      slotGranularityMin={business.slotGranularityMin}
    />
  );
}
