import type { Metadata } from "next";
import { Contact } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = {
  title: "Customers",
};

/**
 * Placeholder. The rail needs somewhere to go, and an empty state that says
 * what is coming beats a 404 that says nothing.
 */
export default function CustomersPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Customers"
        title="Customers"
        description="Everyone who has booked, with their contact details and history."
      />

      <EmptyState
        icon={Contact}
        title="No customers yet"
        description="Customers appear here the first time somebody books. They never get an account — they book as guests and manage the appointment through a signed link."
      />
    </div>
  );
}
