"use client";

import { RouteError } from "@/components/route-error";

/**
 * The boundary on somebody's own appointment.
 *
 * The reassurance is the important part: a page that fails to load here looks
 * exactly like a cancelled appointment to the person reading it, and it is
 * not one.
 */
export default function ManageError({
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
        title="Your appointment did not load"
        description="This is the page failing, not your booking — it is still in the diary exactly as it was. Try again, or use the link in your confirmation email."
      />
    </main>
  );
}
