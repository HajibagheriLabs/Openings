"use client";

import { formatDuration, formatInstantRange } from "@/components/time-text";
import type { RibbonColumn, RibbonSegment, SegmentState } from "@/components/ribbon";
import { formatLocalMinuteRange } from "@/lib/scheduling/week";
import { cn } from "@/lib/utils";

/**
 * The agenda, as a list.
 *
 * ═══ WHY THE OWNER GETS ONE TOO ═══
 *
 * The customer's picker has had a list view since it was built (see
 * SlotList), and the reason applies with more force here: the agenda is a
 * POSITIONED GRID. Meaning lives in where a block sits, how tall it is, which
 * lane it is in and what pattern fills it — and every one of those is a visual
 * channel. A screen reader user meets the same information as a pile of
 * absolutely positioned buttons in DOM order; a switch user meets seven
 * columns of them. The strip is the right drawing of a day and it is not the
 * only reading of one.
 *
 * So this is the same day, in reading order: grouped by lane, sorted by time,
 * one row each, every row the same height, and the state written out in words
 * rather than drawn in a hatch.
 *
 * ═══ SAME DATA, NOT A SECOND QUERY ═══
 *
 * It takes the `RibbonColumn[]` the Ribbon takes and calls the same handler
 * with the same segment. There is no second idea of what the day contains, so
 * the two views cannot drift apart — which is the whole reason the customer's
 * list was built this way and the reason to repeat it here.
 */

/** The state, in words, since there is no pattern to read. */
const STATE_WORD: Record<SegmentState, string> = {
  open: "Open",
  selected: "Held for you",
  held: "Held",
  booked: "Booked",
  blocked: "Blocked",
  past: "Past",
};

export function AgendaList({
  columns,
  timeZone,
  onSelectSegment,
  className,
}: {
  columns: RibbonColumn[];
  /** IANA identifier. Used to FORMAT instants, never to compute. */
  timeZone: string;
  /** Omit to render the whole list read-only. */
  onSelectSegment?: (segment: RibbonSegment, columnId: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-6", className)}>
      {columns.map((column) => {
        /* Sorted here rather than trusted: the ribbon does not care what order
           it is handed segments in, because it positions them. A list does. */
        const rows = [...column.segments].sort(
          (a, b) => a.startMinute - b.startMinute,
        );

        return (
          <section
            key={column.id}
            aria-label={column.label}
            className="overflow-hidden rounded-card border border-line bg-surface"
          >
            <header className="flex items-baseline justify-between gap-3 border-b border-line px-5 py-3">
              <h3 className="type-section text-ink">{column.label}</h3>
              {column.sublabel ? (
                <p className="type-body-sm text-ink-faint">{column.sublabel}</p>
              ) : null}
            </header>

            {rows.length === 0 ? (
              <p className="type-body px-5 py-6 text-ink-muted">
                Nothing in this day.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {rows.map((segment) => (
                  <li key={segment.id}>
                    <Row
                      segment={segment}
                      timeZone={timeZone}
                      onSelect={
                        onSelectSegment
                          ? () => onSelectSegment(segment, column.id)
                          : undefined
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Row({
  segment,
  timeZone,
  onSelect,
}: {
  segment: RibbonSegment;
  timeZone: string;
  onSelect?: () => void;
}) {
  /* Instants when there are instants, the wall clock when there are not —
     the same rule, and the same reason, as RibbonSegmentView. */
  const range =
    segment.startsAt && segment.endsAt
      ? formatInstantRange(segment.startsAt, segment.endsAt, timeZone)
      : formatLocalMinuteRange(segment.startMinute, segment.durationMin);

  /**
   * Pressable, on the owner's rules.
   *
   * The agenda marks its appointments `selectable` because pressing one opens
   * the detail sheet, including this morning's — "mark as a no-show" is a
   * decision made after the fact. Anything without the flag is a statement.
   */
  const offered = segment.selectable ?? false;
  const inert = !onSelect || segment.disabled || !offered;

  const body = (
    <>
      {/* 44px minimum, and the time first: it is the column an owner scans. */}
      <span className="type-time w-32 shrink-0 text-ink">{range}</span>

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="type-section truncate text-ink">
          {segment.label ?? STATE_WORD[segment.state]}
        </span>
        <span className="type-body-sm text-ink-muted">
          {formatDuration(segment.durationMin)} ·{" "}
          {STATE_WORD[segment.state].toLowerCase()}
          {segment.isPast && segment.state !== "past" ? " · already passed" : ""}
        </span>
      </span>
    </>
  );

  const shared = cn(
    "flex w-full min-h-11 items-center gap-4 px-5 py-3 text-left",
    /* Carved, not faded — the same rule as the day list beside the ribbon. An
       opacity dim on a row that is still a button drops its own text under
       4.5:1, so past material takes the sunk fill instead, which is this
       design system's word for time that has been used up and costs no
       contrast at all. The row also says "already passed" in words. */
    (segment.isPast || segment.state === "past") && "bg-surface-sunk",
  );

  if (inert) {
    return <div className={shared}>{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(shared, "transition-colors hover:bg-surface-sunk")}
    >
      {body}
    </button>
  );
}
