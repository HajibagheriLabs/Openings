"use client";

import Link from "next/link";
import { useEffect } from "react";

import { ErrorState } from "@/components/error-state";
import { PillButton } from "@/components/pill-button";
import { cn } from "@/lib/utils";

/**
 * What every `error.tsx` in this application renders.
 *
 * ═══ IT NEVER PRINTS THE ERROR ═══
 *
 * React strips a Server Component's error message in production and hands the
 * browser a digest instead, so `error.message` here is either a stack trace
 * from a developer's laptop or the literal string "An error occurred in the
 * Server Components render". Neither is worth showing anybody. What is shown
 * is a written sentence about what failed and what to do about it, plus the
 * digest in small type — that is the one string that lets a report be matched
 * against a server log, and it is deliberately not dressed up as an error code
 * the reader is supposed to understand.
 *
 * "23P01" NEVER REACHES THIS SCREEN, and that is by design rather than by
 * filtering. The exclusion constraint is caught where it is raised, in the
 * booking transaction, and comes back as "that time was just taken" with the
 * nearest alternatives attached. A boundary is for the failures nobody
 * anticipated; the ones that were anticipated are answers, not errors.
 *
 * `reset()` re-renders the segment that threw, which is a real retry for the
 * common causes here — a dropped database connection, a cold start that timed
 * out, a deploy landing mid-request.
 */
export function RouteError({
  error,
  reset,
  title,
  description,
  /** Somewhere to go when retrying is not the answer. */
  secondary,
  className,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  title: string;
  description: string;
  secondary?: { href: string; label: string };
  className?: string;
}) {
  useEffect(() => {
    /* The server already logged this; the browser console is for whoever has
       the page open in front of them. */
    console.error(error);
  }, [error]);

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <ErrorState
        title={title}
        description={description}
        action={
          <div className="flex flex-wrap items-center gap-3">
            <PillButton onClick={reset}>Try again</PillButton>

            {secondary ? (
              <PillButton asChild variant="secondary">
                <Link href={secondary.href}>{secondary.label}</Link>
              </PillButton>
            ) : null}
          </div>
        }
      />

      {error.digest ? (
        <p className="type-body-sm text-ink-faint">
          If you get in touch about this, quote{" "}
          <span className="tabular">{error.digest}</span>.
        </p>
      ) : null}
    </div>
  );
}
