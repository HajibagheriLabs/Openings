import type { Metadata } from "next";

import { TimeOffManager } from "@/components/admin/time-off/time-off-manager";
import {
  getOwnedBusiness,
  requireBusinessAccess,
  requireUser,
} from "@/lib/auth-server";
import { Temporal } from "@/lib/scheduling/temporal";
import { loadTimeOff, loadTimeOffTargets } from "@/server/queries/hours";

export const metadata: Metadata = {
  title: "Time off",
};

/**
 * Holidays and one-off closures.
 *
 * Everything the client receives is an ISO instant plus the business timezone.
 * The day counts and the "is this whole local days" judgement are made here,
 * with Temporal, because both depend on where a local day actually begins —
 * and both are wrong if computed by dividing a range by 24 hours.
 */
export default async function TimeOffPage() {
  const user = await requireUser("/admin/time-off");
  const owned = await getOwnedBusiness(user.id);

  const { business } = await requireBusinessAccess(owned!.id);

  const today = Temporal.Now.plainDateISO(business.timezone).toString();

  const [entries, staff] = await Promise.all([
    loadTimeOff(business.id, business.timezone),
    loadTimeOffTargets(business.id),
  ]);

  return (
    <TimeOffManager
      entries={entries}
      staff={staff.map((member) => ({
        id: member.id,
        name: member.name,
        isActive: member.isActive,
      }))}
      timeZone={business.timezone}
      today={today}
    />
  );
}
