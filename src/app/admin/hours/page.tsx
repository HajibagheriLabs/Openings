import type { Metadata } from "next";
import { Clock } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = {
  title: "Hours",
};

/**
 * Placeholder. The rail needs somewhere to go, and an empty state that says
 * what is coming beats a 404 that says nothing.
 */
export default function HoursPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Hours"
        title="Opening hours"
        description="Your recurring weekly hours, plus holidays and one-off closures."
      />

      <EmptyState
        icon={Clock}
        title="Hours are set from your weekly pattern"
        description="They are stored as local wall-clock times, so nine o'clock stays nine o'clock through a daylight-saving change. Editing them lands here."
      />
    </div>
  );
}
