"use client";

import { useRef, useState } from "react";

import { formatLocalMinuteRange } from "@/lib/scheduling/week";

import { lengthPx, offsetPx, type RibbonWindow } from "./scale";

/**
 * Dragging a range out of an empty stretch of the strip.
 *
 * ═══ WHY THIS LIVES IN THE RIBBON ═══
 *
 * The Ribbon does no date arithmetic and never will. What it does own, and has
 * owned since the first line of it, is the conversion between pixels and
 * minutes — the scale IS the component. A pointer at y=312 being minute 675 is
 * that same conversion read backwards, so it belongs here and nowhere else. The
 * component emits MINUTES SINCE LOCAL MIDNIGHT, exactly what it was handed, and
 * the server turns the pair into an instant in the business's timezone. No
 * `Date` is constructed anywhere in this file.
 *
 * ═══ WHY IT SITS UNDER THE SEGMENTS ═══
 *
 * This layer fills the column and the segments paint over it. Inert segments —
 * open time, closures — are `pointer-events-none`, so a press on them reaches
 * this layer and a drag begins. Interactive ones — a booked appointment in the
 * owner's agenda — are real buttons and swallow the press, so pressing an
 * appointment opens it instead of starting a drag. That is "drag on an empty
 * region", expressed as paint order rather than as a hit test nobody can read.
 */

export interface RibbonRange {
  startMinute: number;
  endMinute: number;
}

export function RangeSelectLayer({
  columnId,
  window,
  pxPerMin,
  snapMinutes,
  minMinutes,
  onSelect,
  label,
}: {
  columnId: string;
  window: RibbonWindow;
  pxPerMin: number;
  /** The grid a dragged edge lands on. The business's slot granularity. */
  snapMinutes: number;
  /** A flick of the wrist is not a range. Shorter drags are discarded. */
  minMinutes: number;
  onSelect: (columnId: string, range: RibbonRange) => void;
  /** Names the drag surface for assistive technology. */
  label: string;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const anchor = useRef<number | null>(null);
  const [range, setRange] = useState<RibbonRange | null>(null);

  /** A client Y into a minute on this column's ruler, snapped to the grid. */
  function minuteAt(clientY: number): number {
    const box = surface.current?.getBoundingClientRect();

    if (!box) {
      return window.startMinute;
    }

    const raw = window.startMinute + (clientY - box.top) / pxPerMin;
    const snapped = Math.round(raw / snapMinutes) * snapMinutes;

    return Math.min(Math.max(snapped, window.startMinute), window.endMinute);
  }

  function orderedRange(a: number, b: number): RibbonRange {
    return { startMinute: Math.min(a, b), endMinute: Math.max(a, b) };
  }

  return (
    <div
      ref={surface}
      role="presentation"
      aria-label={label}
      /**
       * `pan-y`, NOT `none`.
       *
       * This layer covers the whole column, and the column lives inside a
       * vertically scrolling ribbon. `touch-action: none` here would mean a
       * finger dragged anywhere over the day scrolls nothing — the calendar
       * would be frozen on a phone, which is where half of this product is
       * read.
       */
      className="absolute inset-0 touch-pan-y"
      onPointerDown={(event) => {
        /* Primary button only. A right-click is a context menu and a middle
           click is a paste on some platforms; neither is a gesture. */
        if (event.button !== 0) {
          return;
        }

        /**
         * NOT ON TOUCH, deliberately.
         *
         * A vertical drag with a finger already means "scroll the day", and
         * there is no way to claim it for a second meaning that does not
         * either break scrolling or require a long-press the owner has to be
         * taught. Touch gets the Block time button and the same form the drag
         * opens, which is the alternative the design already calls for — the
         * drag is the shortcut, never the only door.
         */
        if (event.pointerType === "touch") {
          return;
        }

        const minute = minuteAt(event.clientY);

        anchor.current = minute;
        setRange({ startMinute: minute, endMinute: minute });

        /* Capture, so a drag that leaves the column — or leaves the window —
           still reports its moves here and still ends. Without it, releasing
           the pointer outside would leave a band drawn forever. */
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (anchor.current === null) {
          return;
        }

        setRange(orderedRange(anchor.current, minuteAt(event.clientY)));
      }}
      onPointerUp={(event) => {
        if (anchor.current === null) {
          return;
        }

        const finished = orderedRange(anchor.current, minuteAt(event.clientY));

        anchor.current = null;
        setRange(null);

        /* A tap is not a drag. Somebody pressing an empty patch of Tuesday
           meant to press it, not to block one minute of it. */
        if (finished.endMinute - finished.startMinute >= minMinutes) {
          onSelect(columnId, finished);
        }
      }}
      onPointerCancel={() => {
        anchor.current = null;
        setRange(null);
      }}
    >
      {range && range.endMinute > range.startMinute ? (
        <div
          /**
           * The provisional band, in the ACCENT — the one place on the ribbon
           * where the accent means something other than open time, and it
           * still means the same thing underneath: this is the piece you are
           * acting on. It is drawn above the segments so it reads across
           * whatever it covers.
           */
          className="pointer-events-none absolute inset-x-1 z-10 flex items-start justify-center rounded-segment border border-accent bg-accent/25"
          style={{
            top: offsetPx(range.startMinute, window, pxPerMin),
            height: lengthPx(range.endMinute - range.startMinute, pxPerMin),
          }}
        >
          <span className="type-label mt-0.5 rounded-pill bg-surface px-2 text-ink">
            {formatLocalMinuteRange(
              range.startMinute,
              range.endMinute - range.startMinute,
            )}
          </span>
        </div>
      ) : null}
    </div>
  );
}
