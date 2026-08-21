import { cn } from "@/lib/utils";

/**
 * How far through a flow you are — a thin line, never numbered circles.
 *
 * Circles turn three steps into a diagram that has to be read; a filling line
 * is understood without being looked at. It is the accent, because progress
 * through a booking is a primary thing, and it is 2px because it should
 * register in peripheral vision and nowhere else.
 *
 * The step is announced properly for assistive technology, which cannot see a
 * line at all.
 */
export function ProgressLine({
  step,
  total,
  label = "Progress",
  className,
}: {
  /** 1-based. */
  step: number;
  total: number;
  label?: string;
  className?: string;
}) {
  const clamped = Math.min(Math.max(step, 1), total);

  return (
    <div
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={clamped}
      aria-valuetext={`Step ${clamped} of ${total}`}
      aria-label={label}
      className={cn(
        "h-0.5 w-full overflow-hidden rounded-pill bg-surface-sunk",
        className,
      )}
    >
      <div
        className="h-full bg-accent transition-[width] duration-200"
        style={{ width: `${(clamped / total) * 100}%` }}
      />
    </div>
  );
}
