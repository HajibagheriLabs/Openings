import type { ReactNode } from "react";

import { ProgressLine } from "@/components/progress-line";
import { ThemeToggle } from "@/components/theme-toggle";
import { Toaster } from "@/components/toaster";
import { cn } from "@/lib/utils";

/**
 * The customer's side: ONE mobile-first column, 560px at most.
 *
 * No rail, no dashboard chrome, no navigation to speak of. Somebody who wants
 * a haircut on Thursday has one path through this and every extra element on
 * screen is a chance to lose them. The progress line is a thin filling rule at
 * the very top — never numbered circles.
 *
 * The summary bar is sticky at the BOTTOM on mobile, where a thumb is, and it
 * is one of the few surfaces allowed --shadow-float, because it genuinely
 * floats over the scrolling column.
 *
 * Every step renders its own shell. The `header` and `choices` slots take
 * SERVER-RENDERED nodes, which is what lets the two steps that need client
 * state — the calendar, and the time picker with its hold countdown — sit
 * inside the same frame as the two that do not without dragging the business
 * header into the browser bundle.
 */
export function BookingShell({
  step,
  totalSteps,
  header,
  choices,
  summary,
  children,
  className,
}: {
  /** 1-based. Omit both to hide the progress line on a landing screen. */
  step?: number;
  totalSteps?: number;
  /** The business: name, description, address, timezone. */
  header?: ReactNode;
  /** What has been chosen so far, each piece changeable. */
  choices?: ReactNode;
  /** The sticky bar. Typically the chosen time, the price, and one button. */
  summary?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const showProgress =
    typeof step === "number" && typeof totalSteps === "number";

  return (
    <div className="flex min-h-dvh flex-col">
      {showProgress ? (
        <ProgressLine
          step={step}
          total={totalSteps}
          label="Booking progress"
          className="sticky top-0 z-30 rounded-none"
        />
      ) : null}

      <div className="mx-auto flex w-full max-w-[560px] justify-end px-5 pt-4">
        <ThemeToggle />
      </div>

      <main
        className={cn(
          "mx-auto flex w-full max-w-[560px] flex-1 flex-col gap-8 px-5 pt-2",
          // Room for the sticky bar, so the last control is never trapped
          // underneath it.
          summary ? "pb-40" : "pb-12",
          className,
        )}
      >
        {header}
        {choices}
        {children}
      </main>

      {summary ? (
        <div className="sticky bottom-0 z-30 border-t border-line bg-surface shadow-float">
          <div className="mx-auto w-full max-w-[560px] px-5 py-4">
            {summary}
          </div>
        </div>
      ) : null}

      {/* Toasts are CHROME — the only surface allowed the system-state
          colours, and never the ribbon. The customer needs them for exactly
          one thing: a slot going while they are looking at it. */}
      <Toaster />
    </div>
  );
}
