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
        /* The bar is wrapped rather than made sticky itself, and it is a
           <header> rather than a bare div: a progressbar sitting outside every
           landmark is content a screen reader user cannot reach by landmark
           navigation, which axe reports and which is exactly the sort of thing
           that only shows up when somebody navigates that way. The sticky
           lives on the wrapper so the behaviour is unchanged. */
        <header className="sticky top-0 z-30">
          <ProgressLine
            step={step}
            total={totalSteps}
            label="Booking progress"
            className="rounded-none"
          />
        </header>
      ) : null}

      <div className="mx-auto flex w-full max-w-[560px] justify-end px-5 pt-4">
        <ThemeToggle />
      </div>

      <main
        className={cn(
          "mx-auto flex w-full max-w-[560px] flex-1 flex-col gap-8 px-5 pt-2",
          /* Room for the sticky bar, so the last control is never trapped
             underneath it. 176px clears the tallest the bar gets — the time
             step, where it carries the held range, the countdown and the
             button — with room left for the home indicator on a phone. */
          summary ? "pb-44" : "pb-12",
          className,
        )}
      >
        {header}
        {choices}
        {children}
      </main>

      {summary ? (
        /* A named region, not a div. It holds the chosen time, the hold
           countdown and the button that moves the booking on — the most
           important thing on the page after the picker itself — and a landmark
           is how somebody who is not looking at it gets there directly. */
        <section
          aria-label="Your booking"
          className="sticky bottom-0 z-30 border-t border-line bg-surface shadow-float"
        >
          {/* The extra bottom padding is the phone's home indicator. Without
              it the Continue button sits under the swipe area on every
              modern iPhone, which is the single most-tapped control in the
              flow and the one it is least acceptable to lose. */}
          <div className="mx-auto w-full max-w-[560px] px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {summary}
          </div>
        </section>
      ) : null}

      {/* Toasts are CHROME — the only surface allowed the system-state
          colours, and never the ribbon. The customer needs them for exactly
          one thing: a slot going while they are looking at it. */}
      <Toaster />
    </div>
  );
}
