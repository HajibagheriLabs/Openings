"use client";

import { formatDuration, formatInstantRange } from "@/components/time-text";
import { formatLocalMinuteRange } from "@/lib/scheduling/week";
import { cn } from "@/lib/utils";

import { hitAreaInsetPx, lengthPx, offsetPx } from "./scale";
import type { RibbonSegment, SegmentState } from "./types";

/**
 * One span of time, drawn to scale.
 *
 * THE STATES DIFFER BY FILL, PATTERN AND VALUE — NEVER BY HUE. Read the class
 * table below as the accessibility thesis of the product, not as styling: a
 * red/green grid would put the entire meaning of the page in a channel that
 * 8% of men cannot read, and would spend the accent on decoration instead of
 * on the one thing it means here, which is open time.
 */

/** What a screen reader is told the state IS, since it cannot see the hatch. */
const STATE_DESCRIPTION: Record<SegmentState, string> = {
  open: "open",
  selected: "held for you",
  held: "held by someone else",
  booked: "booked",
  blocked: "unavailable",
  past: "in the past",
};

/** The visible word, when the segment is tall enough to carry one. */
const STATE_LABEL: Record<SegmentState, string> = {
  open: "Open",
  selected: "Held for you",
  held: "Held",
  booked: "Booked",
  blocked: "Blocked",
  past: "Past",
};

/**
 * The encoding itself.
 *
 * `rounded-segment` is 2px on every one of them — soft controls, hard time.
 * None of them carries a shadow except `booked`, and that shadow points
 * INWARD: an appointment is carved out of the day, never stacked on top of it.
 * The ribbon is never raised.
 */
const STATE_CLASSES: Record<SegmentState, string> = {
  open: "border border-accent bg-accent-wash text-accent",
  selected:
    "border border-accent bg-accent text-accent-contrast",
  held: "hatch bg-surface-sunk text-ink-faint",
  booked: "bg-surface-sunk text-ink-muted shadow-inset",
  blocked: "hatch-dense bg-surface-sunk text-ink-faint",
  past: "bg-surface-sunk text-ink-faint",
};

/** Only open time is pressable. Everything else is a fact, not an offer. */
const INTERACTIVE_STATES: ReadonlySet<SegmentState> = new Set<SegmentState>([
  "open",
  "selected",
]);

export function RibbonSegmentView({
  segment,
  window,
  pxPerMin,
  timeZone,
  locale,
  onSelect,
}: {
  segment: RibbonSegment;
  window: { startMinute: number; endMinute: number };
  pxPerMin: number;
  timeZone: string;
  locale?: string;
  onSelect?: (segment: RibbonSegment) => void;
}) {
  const top = offsetPx(segment.startMinute, window, pxPerMin);
  const height = lengthPx(segment.durationMin, pxPerMin);

  /**
   * The label, from instants when there are instants and from the wall clock
   * when there are not.
   *
   * A concrete day always supplies instants and gets them formatted in the
   * business's zone. A recurring weekly pattern has none — see the note on
   * RibbonSegment.startsAt — so it is labelled from the minute it sits at,
   * which is the same number the geometry above already used.
   */
  const range =
    segment.startsAt && segment.endsAt
      ? formatInstantRange(segment.startsAt, segment.endsAt, timeZone, locale)
      : formatLocalMinuteRange(segment.startMinute, segment.durationMin);

  const duration = formatDuration(segment.durationMin);

  const inert =
    segment.isPast ||
    segment.disabled ||
    !INTERACTIVE_STATES.has(segment.state) ||
    !onSelect;

  /**
   * Everything a sighted person gets from position, size, fill and pattern,
   * said out loud: when it is, how long it is, and what it is.
   */
  const description = [
    range,
    duration,
    STATE_DESCRIPTION[segment.state],
    segment.isPast && segment.state !== "past" ? "already passed" : null,
    segment.label,
  ]
    .filter(Boolean)
    .join(", ");

  /**
   * A 15-minute slot is 24px at the default scale. The box stays 24px —
   * lying about it would break the proportionality the whole component
   * exists for — and this pushes the pressable area out to 44px instead.
   */
  const hitInset = inert ? 0 : hitAreaInsetPx(height);

  /** Below about two lines there is only room for the time. */
  const compact = height < 34;

  const body = (
    <>
      {segment.state === "selected" &&
      typeof segment.holdRemaining === "number" ? (
        <HoldBar remaining={segment.holdRemaining} />
      ) : null}

      <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
        <span className="type-time truncate">{range.split(" – ")[0]}</span>

        {!compact ? (
          <span className="type-body-sm truncate font-medium">
            {segment.label ?? STATE_LABEL[segment.state]}
          </span>
        ) : null}
      </span>

      {hitInset > 0 ? (
        /**
         * The hit area, extended without moving the drawing. Clicks on this
         * span bubble to the button that owns it.
         */
        <span
          aria-hidden="true"
          className="absolute inset-x-0"
          style={{ top: -hitInset, bottom: -hitInset }}
        />
      ) : null}
    </>
  );

  const shared = cn(
    "absolute inset-x-1 flex items-center overflow-hidden rounded-segment px-2 text-left",
    STATE_CLASSES[segment.state],
    // 45%, whether the segment IS the past or merely happened in it.
    (segment.isPast || segment.state === "past") && "opacity-45",
    // 240ms is the one transition on the ribbon: a slot someone else takes
    // fades to hatched rather than snapping. globals.css drops it entirely
    // under prefers-reduced-motion.
    "transition-colors duration-[240ms]",
  );

  const style = { top, height };

  if (inert) {
    return (
      <div
        className={cn(shared, "cursor-default")}
        style={style}
        role="img"
        aria-label={description}
      >
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect?.(segment)}
      aria-label={description}
      aria-pressed={segment.state === "selected"}
      className={cn(shared, "touch-manipulation")}
      style={style}
    >
      {body}
    </button>
  );
}

/**
 * The depleting hold bar.
 *
 * It runs along the TOP EDGE of the selected segment and shortens linearly
 * and honestly — it shows the real remaining time on a real database hold, not
 * a decorative progress animation. The width is whatever fraction it is
 * handed; whatever counts down lives with the hold.
 */
function HoldBar({ remaining }: { remaining: number }) {
  const clamped = Math.min(Math.max(remaining, 0), 1);

  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-accent-contrast/25"
    >
      <span
        className="block h-full bg-accent-contrast"
        style={{ width: `${clamped * 100}%` }}
      />
    </span>
  );
}
