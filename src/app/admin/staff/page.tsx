import type { Metadata } from "next";

import { StaffManager } from "@/components/admin/staff/staff-manager";
import {
  getOwnedBusiness,
  requireBusinessAccess,
  requireUser,
} from "@/lib/auth-server";
import { loadServiceRows, loadStaffRows } from "@/server/queries/catalog";

export const metadata: Metadata = {
  title: "Staff",
};

/**
 * The staff screen.
 *
 * Loads the services too, because assignment is editable from both sides and
 * this page owns one of them. The future-appointment counts come from the same
 * query, so the deactivation warning states a real number rather than a
 * hedge.
 */
export default async function StaffPage() {
  const user = await requireUser("/admin/staff");
  const owned = await getOwnedBusiness(user.id);

  const { business } = await requireBusinessAccess(owned!.id);

  const [staff, services] = await Promise.all([
    loadStaffRows(business.id),
    loadServiceRows(business.id, business.slotGranularityMin),
  ]);

  return <StaffManager staff={staff} services={services} />;
}
