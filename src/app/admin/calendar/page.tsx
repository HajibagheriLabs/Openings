import type { Metadata } from "next";
import { CalendarDays } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = {
  title: "Calendar",
};

/**
 * Placeholder. The rail needs somewhere to go, and an empty state that says
 * what is coming beats a 404 that says nothing.
 */
export default function CalendarPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Calendar"
        title="The week ahead"
        description="The same Ribbon as Today, scrolled across a week instead of a day — same scale, same encoding, more columns."
      />

      <EmptyState
        icon={CalendarDays}
        title="No calendar yet"
        description="This is where the week view lands. It reuses the Ribbon component, so a 90-minute appointment will occupy three times a 30-minute one here too."
      />
    </div>
  );
}
