"use client";

import { RouteError } from "@/components/route-error";

/**
 * The owner area's boundary.
 *
 * Inside the admin layout, so the rail, the top bar and the timezone chip stay
 * on screen and the owner can walk to another page rather than being dumped on
 * a blank one. That is the whole reason this sits here rather than at the root.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError
      error={error}
      reset={reset}
      title="This page did not load"
      description="Nothing has been changed and no bookings were affected. Try again, and if it keeps happening your diary is still safe — customers can book while this screen is broken."
      secondary={{ href: "/admin", label: "Go to today" }}
    />
  );
}
