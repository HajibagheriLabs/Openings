"use client";

import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "@/lib/utils";

import { NowLine } from "./now-line";
import { RangeSelectLayer, type RibbonRange } from "./range-select";
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
  /**
   * Dragging an empty stretch of a column produces a range, in MINUTES SINCE
   * LOCAL MIDNIGHT. Omit and no drag surface is mounted at all.
   *
   * The Ribbon converts pixels to minutes because the scale is what it is for;
   * it does not know what a range means. The owner's calendar turns one into
   * blocked time. See ./range-select.tsx.
   */
  onSelectRange?: (columnId: string, range: RibbonRange) => void;
  /** The grid a dragged edge snaps to. The business's slot granularity. */
  snapMinutes?: number;
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
  onSelectRange,
  snapMinutes = 15,
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

  /* ---------------------------------------------------------------------
     THE KEYBOARD GRID

     ═══ ONE TAB STOP, THEN ARROWS ═══

     A working day at the default granularity is thirty-odd open slots. Making
     every one of them a tab stop is technically "keyboard accessible" and is
     miserable to use: reaching Continue means thirty presses of Tab, and
     reaching four in the afternoon means counting them. So the strip is a
     roving tabindex, which is what WAI-ARIA prescribes for a set of peers —
     Tab puts you on the strip, arrows move within it, Tab takes you off it.

     ↑ / ↓  the previous or next pressable segment in this COLUMN, in time
            order. That is the reading direction of the ribbon: down is later.
     ← / →  the same TIME in the column beside this one — the segment whose
            start is nearest, not the one at the same index, because two staff
            members' days do not line up slot for slot. A single-column picker
            has nowhere to go and lets the key through.
     Home / End   the first and last pressable segment in the column.

     Enter and Space are the button's own and are deliberately left alone.

     WHY IT INDEXES PRESSABLE SEGMENTS ONLY. A booked hour is drawn as a div
     with role="img", never a button — it is a fact, not an offer — so it is
     not in the order here either. Screen reader users still meet every one of
     them: they are in the accessible tree with their full labels, and the
     arrow keys are for choosing, not for reading.
  --------------------------------------------------------------------- */

  const instructionsId = useId();

  /** Pressable segments, per column, in time order. */
  const focusable = useMemo(
    () =>
      columns.map((column) =>
        column.segments
          .filter((segment) => isPressable(segment, Boolean(onSelectSegment)))
          .sort((a, b) => a.startMinute - b.startMinute),
      ),
    [columns, onSelectSegment],
  );

  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const registerRef = useCallback(
    (id: string, element: HTMLButtonElement | null) => {
      if (element) {
        buttons.current.set(id, element);
      } else {
        buttons.current.delete(id);
      }
    },
    [],
  );

  /**
   * Which segment currently carries tabIndex=0.
   *
   * Null means "nothing chosen yet", and the FIRST pressable segment on the
   * strip takes the tab stop — so Tab lands on the earliest time available,
   * which is the one most people want. It is re-derived rather than repaired
   * whenever the segment it names disappears, which on this screen happens for
   * a real reason: somebody else booked it.
   */
  const [activeId, setActiveId] = useState<string | null>(null);

  const allFocusable = focusable.flat();

  const active =
    (activeId && allFocusable.some((segment) => segment.id === activeId)
      ? activeId
      : null) ??
    allFocusable[0]?.id ??
    null;

  const focusSegment = useCallback((id: string) => {
    setActiveId(id);
    /* No `preventScroll`, deliberately: the strip scrolls, and arrowing to a
       segment below the fold has to bring it into view. The browser's own
       scroll-on-focus is exactly the behaviour wanted. */
    buttons.current.get(id)?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (columnIndex: number, segment: RibbonSegment) =>
      (event: React.KeyboardEvent<HTMLButtonElement>) => {
        const column = focusable[columnIndex];
        const index = column.findIndex((item) => item.id === segment.id);

        if (index === -1) {
          return;
        }

        let target: RibbonSegment | undefined;

        switch (event.key) {
          case "ArrowDown":
            target = column[index + 1];
            break;
          case "ArrowUp":
            target = column[index - 1];
            break;
          case "Home":
            target = column[0];
            break;
          case "End":
            target = column[column.length - 1];
            break;
          case "ArrowRight":
          case "ArrowLeft": {
            const step = event.key === "ArrowRight" ? 1 : -1;

            /* Skip columns with nothing pressable in them rather than stopping
               in one — a staff member who is off today is an empty lane, and
               landing in it would feel like a dead key. */
            for (
              let next = columnIndex + step;
              next >= 0 && next < focusable.length;
              next += step
            ) {
              target = nearestInTime(focusable[next], segment.startMinute);

              if (target) {
                break;
              }
            }
            break;
          }
          default:
            return;
        }

        if (!target) {
          /* At the edge. The vertical keys are consumed anyway, so the page
             does not scroll out from under somebody walking down the strip;
             the horizontal ones are let through, because there is genuinely
             nowhere sideways to go. */
          if (
            event.key === "ArrowDown" ||
            event.key === "ArrowUp" ||
            event.key === "Home" ||
            event.key === "End"
          ) {
            event.preventDefault();
          }
          return;
        }

        event.preventDefault();
        focusSegment(target.id);
      },
    [focusable, focusSegment],
  );

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
              {/* Spacer above the ruler. Pinned like the ruler underneath it,
                  and opaque, so the corner where the two sticky edges meet
                  does not show lanes sliding through it. */}
              <div
                aria-hidden="true"
                className="sticky left-0 z-10 w-14 shrink-0 bg-surface"
              />
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
            aria-describedby={
              allFocusable.length > 1 ? instructionsId : undefined
            }
          >
            <TimeAxis window={window} pxPerMin={pxPerMin} />

            {columns.map((column, columnIndex) => (
              <div
                key={column.id}
                className="relative min-w-[8rem] flex-1 border-l border-line"
                aria-label={column.label}
                role="group"
              >
                <Gridlines window={window} pxPerMin={pxPerMin} />

                {/* UNDER the segments on purpose — inert ones let the pointer
                    through and interactive ones swallow it, which is how "drag
                    on an empty region" is expressed. See ./range-select.tsx. */}
                {onSelectRange ? (
                  <RangeSelectLayer
                    columnId={column.id}
                    window={window}
                    pxPerMin={pxPerMin}
                    snapMinutes={snapMinutes}
                    minMinutes={snapMinutes}
                    onSelect={onSelectRange}
                  />
                ) : null}

                {column.segments.map((segment) => {
                  const pressable = isPressable(
                    segment,
                    Boolean(onSelectSegment),
                  );

                  return (
                    <RibbonSegmentView
                      key={segment.id}
                      segment={segment}
                      window={window}
                      pxPerMin={pxPerMin}
                      timeZone={timeZone}
                      locale={locale}
                      onSelect={onSelectSegment}
                      tabIndex={
                        pressable ? (segment.id === active ? 0 : -1) : undefined
                      }
                      onKeyDown={
                        pressable
                          ? handleKeyDown(columnIndex, segment)
                          : undefined
                      }
                      registerRef={pressable ? registerRef : undefined}
                    />
                  );
                })}
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

      {allFocusable.length > 1 ? (
        <p id={instructionsId} className="sr-only">
          {columns.length > 1
            ? "Use the up and down arrow keys to move between times, and the left and right arrow keys to move between columns."
            : "Use the up and down arrow keys to move between times."}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Whether this segment is a button rather than a statement.
 *
 * Must agree with the `inert` test inside RibbonSegmentView — if the two ever
 * disagree, the roving tabindex either skips a real button or hands the tab
 * stop to something that cannot take focus. The rule is the same in both
 * places: an offer, not disabled, and something to hand it to.
 */
function isPressable(segment: RibbonSegment, hasHandler: boolean): boolean {
  if (!hasHandler || segment.disabled) {
    return false;
  }

  return (
    segment.selectable ??
    ((segment.state === "open" || segment.state === "selected") &&
      !segment.isPast)
  );
}

/**
 * The segment in another column that starts closest to a given minute.
 *
 * Sideways on the ribbon means "the same time over there", not "the same
 * position in the list" — two people's days start at different hours and are
 * cut into different lengths, so index-matching would drift further out of
 * step with every row.
 */
function nearestInTime(
  segments: RibbonSegment[],
  minute: number,
): RibbonSegment | undefined {
  let best: RibbonSegment | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const segment of segments) {
    const distance = Math.abs(segment.startMinute - minute);

    if (distance < bestDistance) {
      best = segment;
      bestDistance = distance;
    }
  }

  return best;
}
