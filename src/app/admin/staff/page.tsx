import type { Metadata } from "next";
import { Users } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = {
  title: "Staff",
};

/**
 * Placeholder. The rail needs somewhere to go, and an empty state that says
 * what is coming beats a 404 that says nothing.
 */
export default function StaffPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Staff"
        title="Staff"
        description="Who takes bookings, and which services each of them performs."
      />

      <EmptyState
        icon={Users}
        title="Just you, for now"
        description="Setup created a staff row in your name. Adding colleagues gives the agenda more columns — the Ribbon already handles as many as you need."
      />
    </div>
  );
}
