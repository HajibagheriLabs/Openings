import { cn } from "@/lib/utils";

import type { SegmentState } from "./types";

/**
 * How to read the strip.
 *
 * The segments carry text labels of their own, so this is not the only place
 * the encoding is spelled out — but a legend is what lets someone learn the
 * pattern language in one glance instead of inferring it. It repeats the
 * swatches at 20px so the hatch densities can actually be told apart.
 */

const LEGEND: { state: SegmentState; swatch: string; text: string }[] = [
  {
    state: "open",
    swatch: "border border-accent bg-accent-wash",
    text: "Open — you can book this",
  },
  {
    state: "selected",
    swatch: "border border-accent bg-accent",
    text: "Held for you — with the time left on the hold",
  },
  {
    state: "held",
    swatch: "hatch bg-surface-sunk",
    text: "Held by someone else — not yours to take",
  },
  {
    state: "booked",
    swatch: "bg-surface-sunk shadow-inset",
    text: "Booked — taken, shown with initials",
  },
  {
    state: "blocked",
    swatch: "hatch-dense bg-surface-sunk",
    text: "Blocked — closed or away",
  },
];

export function RibbonLegend({
  states,
  className,
}: {
  /** Show only the states a given surface can actually produce. */
  states?: SegmentState[];
  className?: string;
}) {
  const shown = states
    ? LEGEND.filter((entry) => states.includes(entry.state))
    : LEGEND;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <h2 className="type-label">How to read this</h2>
      <ul className="flex flex-col gap-2">
        {shown.map((entry) => (
          <li
            key={entry.state}
            className="type-body-sm flex items-center gap-3 text-ink-muted"
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-5 shrink-0 rounded-segment",
                entry.swatch,
              )}
            />
            {entry.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
