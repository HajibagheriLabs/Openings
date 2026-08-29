import type { Metadata } from "next";
import { Settings } from "lucide-react";

import { DeliveryStatus } from "@/components/admin/settings/delivery-status";
import { ReminderSettings } from "@/components/admin/settings/reminder-settings";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { db } from "@/db";
import { countScheduled, countUnscheduled } from "@/lib/notifications/delivery";
import { getScheduler } from "@/lib/notifications/scheduler";
import { requireOwnerBusiness } from "@/server/actions/context";

export const metadata: Metadata = {
  title: "Settings",
};

/**
 * Notification settings, and an honest account of how they are delivered.
 *
 * The rest of the settings — business details, booking policy, deposits — land
 * with the policy work and still say so below. What is here now is the part
 * this step made real: when a reminder goes out, and whether anything is
 * scheduling it.
 */
export default async function SettingsPage() {
  const business = await requireOwnerBusiness();
  const scheduler = getScheduler();

  const [scheduled, awaitingCatchUp] = await Promise.all([
    countScheduled(db),
    countUnscheduled(db),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Settings"
        title="Settings"
        description="Your business details, booking policy, deposits and notifications."
      />

      <div className="flex flex-col gap-6">
        <ReminderSettings reminderLeadMin={business.reminderLeadMin} />

        <DeliveryStatus
          configured={scheduler.configured}
          scheduled={scheduled}
          awaitingCatchUp={awaitingCatchUp}
        />
      </div>

      <EmptyState
        icon={Settings}
        title="The rest arrives with the policy work"
        description="Lead time, how far ahead customers can book, the cancellation window and deposit rules all live here."
      />
    </div>
  );
}
