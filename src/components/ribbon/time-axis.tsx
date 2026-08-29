"use client";

import { cn } from "@/lib/utils";

import {
  MINUTES_PER_HALF_HOUR,
  MINUTES_PER_HOUR,
  gridlineMinutes,
  offsetPx,
  type RibbonWindow,
} from "./scale";

/**
 * The ruler down the left edge, and the lines it rules across the day.
 *
 * Hours are labelled and drawn in --line; half hours are drawn lighter and go
 * unlabelled. That difference in VALUE is what gives the strip its sense of
 * depth without adding a second colour or a second shadow.
 *
 * The labels are plain wall-clock numbers in the business's timezone, so they
 * are formatted here from the local minute rather than from an instant — this
 * is a ruler, not an event. Padding a number is not date arithmetic.
 */

/** 540 becomes "09:00". */
function wallClock(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60) % 24;
  const minute = minuteOfDay % 60;

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** The lines, drawn across every lane. Absolutely positioned, never in flow. */
export function Gridlines({
  window,
  pxPerMin,
}: {
  window: RibbonWindow;
  pxPerMin: number;
}) {
  const hours = gridlineMinutes(window, MINUTES_PER_HOUR);
  const halves = gridlineMinutes(window, MINUTES_PER_HALF_HOUR).filter(
    (minute) => minute % MINUTES_PER_HOUR !== 0,
  );

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {halves.map((minute) => (
        <div
          key={`half-${minute}`}
          className="absolute inset-x-0 h-px bg-line/50"
          style={{ top: offsetPx(minute, window, pxPerMin) }}
        />
      ))}

      {hours.map((minute) => (
        <div
          key={`hour-${minute}`}
          className="absolute inset-x-0 h-px bg-line"
          style={{ top: offsetPx(minute, window, pxPerMin) }}
        />
      ))}
    </div>
  );
}

/** The labelled ruler column. */
export function TimeAxis({
  window,
  pxPerMin,
  className,
}: {
  window: RibbonWindow;
  pxPerMin: number;
  className?: string;
}) {
  const hours = gridlineMinutes(window, MINUTES_PER_HOUR);

  return (
    <div
      aria-hidden="true"
      /**
       * PINNED WHILE THE LANES SCROLL SIDEWAYS.
       *
       * A week is seven columns and a busy day can be five staff members, so
       * the strip scrolls horizontally on anything narrower than a desk. A
       * ruler that scrolls away with it makes the whole drawing unreadable —
       * the segments are still to scale, but there is nothing left to read the
       * scale AGAINST. So it sticks to the left edge, over an opaque surface,
       * above the lanes (z-10) and below the sticky column headings (z-20).
       */
      className={cn(
        "sticky left-0 z-10 w-14 shrink-0 select-none bg-surface",
        className,
      )}
    >
      {hours.map((minute) => (
        <span
          key={minute}
          className="type-time absolute right-2 -translate-y-1/2 text-ink-faint"
          style={{ top: offsetPx(minute, window, pxPerMin) }}
        >
          {wallClock(minute)}
        </span>
      ))}
    </div>
  );
}
