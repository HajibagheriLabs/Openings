"use client";

import { RouteError } from "@/components/route-error";

/** The boundary around the four owner account pages. */
export default function AuthError({
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
      title="This did not load"
      description="You have not been signed out and nothing about your account has changed. Try again."
      secondary={{ href: "/sign-in", label: "Go to sign in" }}
    />
  );
}
