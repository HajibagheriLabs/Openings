import type { Metadata } from "next";

import { HoursManager } from "@/components/admin/hours/hours-manager";
import {
  getOwnedBusiness,
  requireBusinessAccess,
  requireUser,
} from "@/lib/auth-server";
import { Temporal } from "@/lib/scheduling/temporal";
import { loadStaffHours } from "@/server/queries/hours";

export const metadata: Metadata = {
  title: "Hours",
};

/**
 * Weekly hours, per staff member, as dated versions.
 *
 * `today` is resolved HERE, on the server, in the BUSINESS's timezone — not in
 * the browser and not in UTC. Every "is this version in force", "can this
 * start date be used" and "is this one still editable" comparison downstream
 * is against this date, so a shop in Auckland is never told its current hours
 * start tomorrow because the server's clock is still on yesterday.
 */
export default async function HoursPage() {
  const user = await requireUser("/admin/hours");
  const owned = await getOwnedBusiness(user.id);

  const { business } = await requireBusinessAccess(owned!.id);

  const today = Temporal.Now.plainDateISO(business.timezone).toString();
  const staff = await loadStaffHours(business.id, today);

  return (
    <HoursManager staff={staff} timeZone={business.timezone} today={today} />
  );
}
