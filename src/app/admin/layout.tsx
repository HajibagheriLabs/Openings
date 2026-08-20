import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { signOutAction } from "@/server/actions/session";
import { getOwnedBusiness, requireUser } from "@/lib/auth-server";
import { APP_NAME } from "@/lib/brand";

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
 * The left rail and the ribbon grid land with the agenda. For now this is the
 * frame they will hang in.
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
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex w-full max-w-[1100px] flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="flex flex-col">
            <p className="type-label">{APP_NAME}</p>
            <p className="type-section text-ink">{business.name}</p>
          </div>

          <div className="flex items-center gap-4">
            <p className="type-body-sm text-ink-muted">{user.email}</p>
            <form action={signOutAction}>
              <button
                type="submit"
                className="type-body-sm rounded-pill border border-line px-4 py-2 text-ink-muted transition-colors hover:bg-surface-sunk"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1100px] flex-1 px-5 py-8">
        {children}
      </main>
    </div>
  );
}
