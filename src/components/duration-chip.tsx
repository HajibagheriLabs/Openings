import { formatDuration } from "@/components/time-text";
import { cn } from "@/lib/utils";

/**
 * How long something takes, as a chip.
 *
 * Epilogue and tabular, like every other quantity of time in the product, so
 * "45 min" and "90 min" line up in a list of services instead of jittering.
 * Neutral by default — a duration is a fact, not a state, and it does not get
 * to spend the accent.
 */
export function DurationChip({
  minutes,
  tone = "neutral",
  className,
}: {
  minutes: number;
  /** `accent` only where the duration IS the thing being chosen. */
  tone?: "neutral" | "accent";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "type-time inline-flex h-7 items-center rounded-pill px-3",
        tone === "accent"
          ? "border border-accent bg-accent-wash text-accent"
          : "border border-line bg-surface-sunk text-ink-muted",
        className,
      )}
    >
      {formatDuration(minutes)}
    </span>
  );
}
