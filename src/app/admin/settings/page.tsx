import type { Metadata } from "next";
import { Settings } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = {
  title: "Settings",
};

/**
 * Placeholder. The rail needs somewhere to go, and an empty state that says
 * what is coming beats a 404 that says nothing.
 */
export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Settings"
        title="Settings"
        description="Your business details, booking policy, deposits and notifications."
      />

      <EmptyState
        icon={Settings}
        title="Settings arrive with the policy work"
        description="Lead time, how far ahead customers can book, the cancellation window and deposit rules all live here."
      />
    </div>
  );
}
