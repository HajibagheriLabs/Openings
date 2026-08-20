import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";
import { getOwnedBusiness, requireUser } from "@/lib/auth-server";

export const metadata: Metadata = {
  title: "Set up your business",
};

export default async function OnboardingPage() {
  // The proxy also guards this path, but it only checked that a session cookie
  // exists. This is the check that counts.
  const user = await requireUser("/onboarding");

  const business = await getOwnedBusiness(user.id);

  /**
   * Already set up, but the proxy sent them here anyway — the business hint
   * cookie is missing, cleared or on another machine.
   *
   * The hop through /api/session/sync is not decoration. A Server Component
   * cannot write a cookie, so redirecting straight to /admin would leave the
   * hint missing, the proxy would bounce them back here, and the two pages
   * would trade the request forever. The route handler can write it, so the
   * loop ends after one extra redirect.
   */
  if (business) {
    redirect("/api/session/sync?to=/admin");
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col justify-center px-5 py-12">
      <OnboardingWizard ownerName={user.name} />
    </main>
  );
}
