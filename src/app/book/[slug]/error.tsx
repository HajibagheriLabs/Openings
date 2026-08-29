"use client";

import { RouteError } from "@/components/route-error";

/**
 * The customer's boundary, and the one that matters most.
 *
 * Somebody trying to book a haircut has no idea what a Server Component is and
 * no reason to care. The copy says the one thing they need — nothing has been
 * charged and no time has been taken from them — and offers the retry, because
 * the likely cause is a request that timed out rather than anything wrong with
 * their booking.
 *
 * A HELD SLOT SURVIVES THIS. The hold is a database row with its own deadline,
 * not something this page is keeping alive, so reloading into a working page
 * finds it still there with its countdown running.
 */
export default function BookingError({
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
        title="This page did not load"
        description="Nothing has been booked and nothing has been charged. Try again — if you had a time held, it is still held."
      />
    </main>
  );
}
