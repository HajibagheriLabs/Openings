"use client";

import { RouteError } from "@/components/route-error";

/**
 * The catch-all under the root layout.
 *
 * Every route group has its own boundary with copy that fits it; this one
 * catches the front page and anything added later that has not grown its own
 * yet. It keeps the fonts, the theme and the canvas, because it renders inside
 * the root layout.
 */
export default function RootError({
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
        description="Something on our side failed while putting this page together. Try again."
        secondary={{ href: "/", label: "Go to the home page" }}
      />
    </main>
  );
}
