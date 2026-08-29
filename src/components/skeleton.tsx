import { cn } from "@/lib/utils";

import {
  DEFAULT_PX_PER_MIN,
  bodyHeightPx,
  gridlineMinutes,
  lengthPx,
  offsetPx,
  type RibbonWindow,
} from "@/components/ribbon";

/**
 * Loading placeholders.
 *
 * They do not pulse. "Nothing else animates" is a rule in this design system,
 * and a shimmering rectangle is decoration pretending to be progress — it adds
 * motion to the exact moment the page is least stable. A quiet --surface-sunk
 * block in the shape of the thing that is coming says the same thing without
 * moving.
 *
 * Radius follows what is being stood in for: a pill for a control, 10px for a
 * panel, 2px for a ribbon segment.
 */
export function Skeleton({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      className={cn("rounded-pill bg-surface-sunk", className)}
      {...props}
    />
  );
}

/** A few lines of text. The last one is short, the way real paragraphs are. */
export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={cn("h-3.5", index === lines - 1 ? "w-2/3" : "w-full")}
        />
      ))}
    </div>
  );
}

/**
 * A plausible day, in minutes past the window start: a couple of appointments,
 * a gap, a long one after lunch. Fixed rather than random, so the placeholder
 * is the same on the server and in the browser and does not re-shuffle on
 * hydration.
 */
const SKELETON_SEGMENTS: ReadonlyArray<{ from: number; length: number }> = [
  { from: 30, length: 45 },
  { from: 105, length: 30 },
  { from: 195, length: 90 },
  { from: 330, length: 60 },
  { from: 450, length: 45 },
];

/**
 * The ribbon, before its segments arrive.
 *
 * Drawn at the real scale, in the real chrome — the same hairline channel, the
 * same 3.5rem time gutter, the same hour gridlines and the same absolutely
 * positioned 2px segments the live component uses. The whole point of a fixed
 * pixel-per-minute scale is that the height of a day is knowable before you
 * know what is in it, so this placeholder is exactly as tall as what replaces
 * it and nothing on the page moves when the data lands.
 *
 * The segments are drawn in --surface-sunk, which is the ribbon's own "not
 * open" material. A placeholder must not borrow the accent: verdigris means
 * open time, and open time is precisely what is not yet known.
 */
export function SkeletonRibbon({
  window = { startMinute: 8 * 60, endMinute: 18 * 60 },
  pxPerMin = DEFAULT_PX_PER_MIN,
  columns = 1,
  columnHeaders = false,
  label = "Loading the day",
  className,
}: {
  window?: RibbonWindow;
  pxPerMin?: number;
  columns?: number;
  /** Match the agenda, which heads each staff lane. The picker does not. */
  columnHeaders?: boolean;
  label?: string;
  className?: string;
}) {
  const height = bodyHeightPx(window, pxPerMin);
  const hours = gridlineMinutes(window, 60);

  return (
    <div
      role="status"
      aria-label={label}
      className={cn(
        "overflow-hidden rounded-card border border-line bg-surface",
        className,
      )}
    >
      {columnHeaders ? (
        <div className="flex border-b border-line">
          <div aria-hidden="true" className="w-14 shrink-0 bg-surface" />
          {Array.from({ length: columns }, (_, column) => (
            <div
              key={column}
              className="flex min-w-[8rem] flex-1 flex-col gap-1.5 border-l border-line px-3 py-2.5"
            >
              <Skeleton className="h-[21px] w-24 max-w-full" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      ) : null}

      <div className="relative flex" style={{ height }}>
        {/* The time gutter, with its hour marks where the real ruler puts them. */}
        <div aria-hidden="true" className="relative w-14 shrink-0 bg-surface">
          {hours.map((minute) => (
            <Skeleton
              key={minute}
              className="absolute right-2 h-3 w-8"
              style={{ top: offsetPx(minute, window, pxPerMin) - 6 }}
            />
          ))}
        </div>

        {Array.from({ length: columns }, (_, column) => (
          <div
            key={column}
            className="relative min-w-[8rem] flex-1 border-l border-line"
          >
            {hours.map((minute) => (
              <div
                key={minute}
                aria-hidden="true"
                className="absolute inset-x-0 h-px bg-line"
                style={{ top: offsetPx(minute, window, pxPerMin) }}
              />
            ))}

            {SKELETON_SEGMENTS.map((segment) => {
              const top = offsetPx(
                window.startMinute + segment.from,
                window,
                pxPerMin,
              );

              if (top + lengthPx(segment.length, pxPerMin) > height) {
                return null;
              }

              return (
                <Skeleton
                  key={segment.from}
                  className="absolute inset-x-1 rounded-segment"
                  style={{ top, height: lengthPx(segment.length, pxPerMin) }}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A page header, before its title arrives.
 *
 * The eyebrow, the title and the sentence, at the heights the real ones
 * occupy. The point of every skeleton in this file is that NOTHING MOVES when
 * the data lands — a placeholder that is the wrong height is a layout shift
 * with extra steps.
 */
export function SkeletonPageHeader({
  description = true,
  action = false,
  className,
}: {
  description?: boolean;
  action?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-x-6 gap-y-4",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-2">
        {/* type-label: 11px/1.4 → 15px. */}
        <Skeleton className="h-[15px] w-24" />
        {/* type-page-title: 22px/1.25 → 28px. */}
        <Skeleton className="h-7 w-64 max-w-full" />
        {description ? <Skeleton className="h-[23px] w-96 max-w-full" /> : null}
      </div>

      {/* A md PillButton is 44px tall and a pill. */}
      {action ? <Skeleton className="h-11 w-40" /> : null}
    </div>
  );
}

/**
 * A stack of rows inside one panel — the shape every manager screen lands in.
 *
 * `rowHeight` is the real row height rather than a guess: the services, staff
 * and time-off lists all draw a two-line row, and a placeholder shorter than
 * that would let the page jump upward as it fills.
 */
export function SkeletonRows({
  rows = 4,
  rowHeight = 72,
  className,
}: {
  rows?: number;
  rowHeight?: number;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn(
        "divide-y divide-line overflow-hidden rounded-card border border-line bg-surface",
        className,
      )}
    >
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-4 px-5"
          style={{ height: rowHeight }}
        >
          <Skeleton className="size-9 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-[21px] w-48 max-w-full" />
            <Skeleton className="h-5 w-32 max-w-full" />
          </div>
          <Skeleton className="h-6 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/**
 * A table, before its rows arrive. The customer book is the only one.
 *
 * It carries its own horizontal scroller for the same reason the real table
 * does — a wide table must scroll inside its panel rather than pushing the
 * page sideways on a phone.
 */
export function SkeletonTable({
  rows = 6,
  columns = 4,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn(
        "overflow-hidden rounded-card border border-line bg-surface",
        className,
      )}
    >
      <div className="overflow-x-auto">
        <div className="min-w-[46rem]">
          <div className="flex items-center gap-4 border-b border-line px-5 py-3">
            {Array.from({ length: columns }, (_, index) => (
              <Skeleton key={index} className="h-4 flex-1" />
            ))}
          </div>

          {Array.from({ length: rows }, (_, row) => (
            <div
              key={row}
              className="flex items-center gap-4 border-b border-line px-5 py-4 last:border-b-0"
            >
              {Array.from({ length: columns }, (_, index) => (
                <Skeleton
                  key={index}
                  className={cn("h-[21px] flex-1", index === 0 ? "" : "opacity-70")}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The month picker, before the openings are known.
 *
 * Six week rows of seven cells, which is the tallest a month grid gets — a
 * five-row month would otherwise grow the card by a row as it loaded.
 */
export function SkeletonCalendar({ className }: { className?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading the month"
      className={cn("rounded-card border border-line bg-surface p-3", className)}
    >
      <div className="flex items-center justify-between px-1 py-2">
        <Skeleton className="size-9" />
        <Skeleton className="h-5 w-32" />
        <Skeleton className="size-9" />
      </div>

      <div className="mt-2 grid grid-cols-7 gap-1">
        {Array.from({ length: 7 }, (_, index) => (
          <Skeleton key={`head-${index}`} className="mx-auto h-3 w-6" />
        ))}
        {Array.from({ length: 42 }, (_, index) => (
          <Skeleton key={index} className="aspect-square w-full rounded-pill" />
        ))}
      </div>
    </div>
  );
}

/** The summary figures and the day list beside the agenda. */
export function SkeletonTodayPanel({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <div className="flex flex-col gap-5 rounded-card border border-line bg-surface p-5">
        <Skeleton className="h-[21px] w-32" />

        <div className="grid grid-cols-2 gap-4">
          {Array.from({ length: 2 }, (_, index) => (
            <div key={index} className="flex flex-col gap-2">
              <Skeleton className="h-[15px] w-16" />
              {/* type-time-lg: 28px/1.1 → 31px. */}
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-5 w-20" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <Skeleton className="h-[15px] w-12" />
          <Skeleton className="h-8 w-40" />
        </div>
      </div>

      <SkeletonRows rows={3} rowHeight={64} />
    </div>
  );
}
