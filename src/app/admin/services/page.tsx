import type { Metadata } from "next";
import { Scissors } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = {
  title: "Services",
};

/**
 * Placeholder. The rail needs somewhere to go, and an empty state that says
 * what is coming beats a 404 that says nothing.
 */
export default function ServicesPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Services"
        title="Services"
        description="What customers can book, how long each takes, and what it costs."
      />

      <EmptyState
        icon={Scissors}
        title="Nothing to manage here yet"
        description="Your first service was created during setup. Editing services, buffers and deposits arrives with the service settings."
      />
    </div>
  );
}
