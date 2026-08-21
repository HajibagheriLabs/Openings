import { cn } from "@/lib/utils";

import { DEFAULT_PX_PER_MIN, bodyHeightPx } from "@/components/ribbon";

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
 * The ribbon, before its segments arrive.
 *
 * Drawn at the real scale so the panel does not resize when the data lands —
 * the whole point of a fixed pixel-per-minute scale is that the height of a
 * day is knowable before you know what is in it.
 */
export function SkeletonRibbon({
  window = { startMinute: 8 * 60, endMinute: 18 * 60 },
  pxPerMin = DEFAULT_PX_PER_MIN,
  columns = 1,
  className,
}: {
  window?: { startMinute: number; endMinute: number };
  pxPerMin?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label="Loading the day"
      className={cn(
        "overflow-hidden rounded-card border border-line bg-surface",
        className,
      )}
    >
      <div
        className="flex"
        style={{ height: bodyHeightPx(window, pxPerMin) }}
      >
        <div aria-hidden="true" className="w-14 shrink-0" />
        {Array.from({ length: columns }, (_, column) => (
          <div
            key={column}
            className="flex flex-1 flex-col gap-2 border-l border-line p-2"
          >
            <Skeleton className="h-16 rounded-segment" />
            <Skeleton className="h-24 rounded-segment" />
            <Skeleton className="h-10 rounded-segment" />
            <Skeleton className="h-32 rounded-segment" />
          </div>
        ))}
      </div>
    </div>
  );
}
