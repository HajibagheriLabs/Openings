"use client";

import { RouteError } from "@/components/route-error";

/** The boundary around setting a business up for the first time. */
export default function OnboardingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col justify-center px-5 py-12">
      <RouteError
        error={error}
        reset={reset}
        title="Setup did not load"
        description="Your account is fine and anything you had already saved is saved. Try again to pick up where you left off."
      />
    </main>
  );
}
