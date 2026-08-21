import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AdminShell } from "@/components/admin/admin-shell";
import { getOwnedBusiness, requireUser } from "@/lib/auth-server";
import { signOutAction } from "@/server/actions/session";

/**
 * The owner area.
 *
 * This layout is the real gate. The proxy redirected on the presence of a
 * cookie; here the session is actually loaded, the business is actually
 * fetched, and an owner with neither gets sent where they belong. Every page
 * nested under this one can assume a signed-in owner with a business, because
 * this ran first — and each of them still calls `requireBusinessAccess` before
 * touching a specific business, because a layout cannot vouch for a route
 * parameter it never saw.
 *
 * The frame itself is a Client Component (it holds the rail's collapsed state
 * and the drawer), so everything it needs is resolved here and handed down as
 * plain props.
 */
export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await requireUser("/admin");
  const business = await getOwnedBusiness(user.id);

  if (!business) {
    redirect("/onboarding");
  }

  return (
    <AdminShell
      businessName={business.name}
      timeZone={business.timezone}
      // Taken here rather than in the browser: the timezone chip names the
      // offset in force right now, and DST means that depends on the date.
      nowInstant={new Date().toISOString()}
      user={{ name: user.name, email: user.email }}
      signOutAction={signOutAction}
    >
      {children}
    </AdminShell>
  );
}
