"use client";

import { useCallback, useEffect, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";

import { NowLine } from "./now-line";
import { RibbonSegmentView } from "./ribbon-segment";
import {
  DEFAULT_PX_PER_MIN,
  bodyHeightPx,
  offsetPx,
  type RibbonWindow,
} from "./scale";
import { Gridlines, TimeAxis } from "./time-axis";
import type { RibbonColumn, RibbonSegment } from "./types";

/* ===========================================================================
   THE RIBBON — the signature of the product.
   ---------------------------------------------------------------------------
   Time as a continuous vertical strip of material at a fixed pixel-per-minute
   scale. A 90-minute service occupies three times a 30-minute one because it
   IS three times as much of the day; a confirmed appointment is carved out of
   the strip rather than stacked on top of it. Everything around it stays
   quiet, because this is the thing the product is remembered by.

   ONE COMPONENT, TWO SURFACES. The customer's day picker is this with one
   column. The admin's agenda is this with one column per staff member. Same
   scale, same encoding, same code — which is the only way the two can stay
   consistent as the product grows.

   IT IS PURE AND PRESENTATIONAL. It receives segments whose geometry the
   server already resolved and draws them. There is no date arithmetic in this
   directory, no availability rules, no hold expiry, no buffers, no knowledge
   of what a booking is. If something here starts needing to know the time, it
   belongs on the server instead.

   THE CHANNEL IS NEVER RAISED. A 1px --line hairline and the --surface fill,
   and that is all. The only shadow anywhere near the ribbon is --shadow-inset,
   pointing inward, on a booked segment.
   =========================================================================== */

export interface RibbonHandle {
  /**
   * Bring the now line into view, roughly centred.
   *
   * The agenda calls this on load. Honours prefers-reduced-motion by jumping
   * rather than smooth-scrolling — a long animated scroll is exactly the kind
   * of motion that setting exists to stop.
   */
  scrollNowIntoView: (behavior?: ScrollBehavior) => void;
}

export interface RibbonProps {
  /** The slice of the day to draw, in minutes since local midnight. */
  window: RibbonWindow;
  /** One per staff member. One column is the customer's picker. */
  columns: RibbonColumn[];
  /** IANA identifier. Used to FORMAT the instants on segments, never to compute. */
  timeZone: string;
  /** Minutes since local midnight, server-resolved. Omit to hide the now line. */
  nowMinute?: number | null;
  /** Pixels per minute. Defaults to the shared scale in ./scale.ts. */
  pxPerMin?: number;
  /** Scroll the now line into view once, on mount. The agenda wants this. */
  autoScrollToNow?: boolean;
  /** Omit to render every segment inert — a read-only ribbon. */
  onSelectSegment?: (segment: RibbonSegment) => void;
  /** Override the pinned formatting locale. See time-text.tsx. */
  locale?: string;
  /** Names the strip for assistive technology, e.g. "Thursday, 20 August". */
  ariaLabel?: string;
  /** Hide the column headings — a single-column picker rarely needs them. */
  hideColumnHeaders?: boolean;
  className?: string;
  ref?: React.Ref<RibbonHandle>;
}

export function Ribbon({
  window,
  columns,
  timeZone,
  nowMinute,
  pxPerMin = DEFAULT_PX_PER_MIN,
  autoScrollToNow = false,
  onSelectSegment,
  locale,
  ariaLabel,
  hideColumnHeaders = false,
  className,
  ref,
}: RibbonProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const height = bodyHeightPx(window, pxPerMin);

  const scrollNowIntoView = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const scroller = scrollerRef.current;

      if (!scroller || typeof nowMinute !== "number") {
        return;
      }

      const reduceMotion = globalThis.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      ).matches;

      scroller.scrollTo({
        // Centred rather than pinned to the top, so the hour before now — the
        // appointment that is probably still in the chair — stays visible.
        top: offsetPx(nowMinute, window, pxPerMin) - scroller.clientHeight / 2,
        behavior: reduceMotion ? "auto" : behavior,
      });
    },
    [nowMinute, window, pxPerMin],
  );

  useImperativeHandle(ref, () => ({ scrollNowIntoView }), [scrollNowIntoView]);

  useEffect(() => {
    if (autoScrollToNow) {
      // "auto" on first paint: the agenda should open already looking at now,
      // not scroll there while the owner watches.
      scrollNowIntoView("auto");
    }
  }, [autoScrollToNow, scrollNowIntoView]);

  return (
    <div
      className={cn(
        // The channel. A hairline and a surface — no shadow, no elevation.
        "relative overflow-hidden rounded-card border border-line bg-surface",
        className,
      )}
    >
      <div
        ref={scrollerRef}
        className="max-h-[70vh] overflow-auto overscroll-contain"
      >
        <div className="min-w-max">
          {!hideColumnHeaders ? (
            <div className="sticky top-0 z-20 flex border-b border-line bg-surface">
              {/* Spacer above the ruler, so headings line up with their lanes. */}
              <div aria-hidden="true" className="w-14 shrink-0" />
              {columns.map((column) => (
                <div
                  key={column.id}
                  className="flex min-w-[8rem] flex-1 flex-col gap-0.5 border-l border-line px-3 py-2"
                >
                  <span className="type-section truncate text-ink">
                    {column.label}
                  </span>
                  {column.sublabel ? (
                    <span className="type-body-sm truncate text-ink-faint">
                      {column.sublabel}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          <div
            className="relative flex"
            style={{ height }}
            role="group"
            aria-label={ariaLabel}
          >
            <TimeAxis window={window} pxPerMin={pxPerMin} />

            {columns.map((column) => (
              <div
                key={column.id}
                className="relative min-w-[8rem] flex-1 border-l border-line"
                aria-label={column.label}
                role="group"
              >
                <Gridlines window={window} pxPerMin={pxPerMin} />

                {column.segments.map((segment) => (
                  <RibbonSegmentView
                    key={segment.id}
                    segment={segment}
                    window={window}
                    pxPerMin={pxPerMin}
                    timeZone={timeZone}
                    locale={locale}
                    onSelect={onSelectSegment}
                  />
                ))}
              </div>
            ))}

            {typeof nowMinute === "number" ? (
              <NowLine
                nowMinute={nowMinute}
                window={window}
                pxPerMin={pxPerMin}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
