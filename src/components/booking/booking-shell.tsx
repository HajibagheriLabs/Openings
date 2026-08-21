import type { ReactNode } from "react";

import { ProgressLine } from "@/components/progress-line";
import { ThemeToggle } from "@/components/theme-toggle";
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
 */
export function BookingShell({
  businessName,
  step,
  totalSteps,
  summary,
  children,
  className,
}: {
  businessName: string;
  /** 1-based. Omit both to hide the progress line on a landing screen. */
  step?: number;
  totalSteps?: number;
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

      <header className="mx-auto flex w-full max-w-[560px] items-center justify-between gap-4 px-5 pt-6">
        <p className="type-label truncate">{businessName}</p>
        <ThemeToggle />
      </header>

      <main
        className={cn(
          "mx-auto flex w-full max-w-[560px] flex-1 flex-col gap-8 px-5 pt-6",
          // Room for the sticky bar, so the last control is never trapped
          // underneath it.
          summary ? "pb-40" : "pb-12",
          className,
        )}
      >
        {children}
      </main>

      {summary ? (
        <div className="sticky bottom-0 z-30 border-t border-line bg-surface shadow-float">
          <div className="mx-auto w-full max-w-[560px] px-5 py-4">
            {summary}
          </div>
        </div>
      ) : null}
    </div>
  );
}
