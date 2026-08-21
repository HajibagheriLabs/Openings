"use client";

import {
  blockedMinutes,
  blockedTimeParts,
  blockedTimeSentence,
  type BufferedTiming,
} from "@/lib/scheduling/blocked-time";
import { cn } from "@/lib/utils";

/**
 * What this service actually costs the day, drawn to scale.
 *
 * The Ribbon's argument, laid on its side and shrunk to fit a form: the three
 * spans are drawn PROPORTIONALLY, so a ten-minute cleanup after a
 * forty-five-minute appointment is visibly a fifth of it. An owner who nudges
 * the buffer from 5 to 20 watches the strip grow, and learns in one gesture
 * what a paragraph of help text would not have taught them.
 *
 * The encoding is the ribbon's, unchanged. The appointment is the accent
 * because it is the part being sold; the buffers are hatched sunk surface
 * because that is what unavailable time looks like everywhere else in this
 * product. No new colours, no green-and-red, and every part is also named in
 * the sentence underneath — the strip is never the only way to read this.
 */
export function BlockedTimePreview({
  timing,
  className,
}: {
  timing: BufferedTiming;
  className?: string;
}) {
  const parts = blockedTimeParts(timing);
  const total = blockedMinutes(timing);

  // A duration of zero is reachable while the field is mid-edit. Dividing by
  // it would produce NaN widths and a strip that vanishes.
  const safeTotal = total > 0 ? total : 1;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div
        className="flex h-11 w-full overflow-hidden rounded-segment border border-line bg-surface-sunk"
        // The strip is decorative; the sentence below carries the same facts
        // in words, and reading both would be reading it twice.
        aria-hidden="true"
      >
        {parts.map((part) => (
          <div
            key={part.kind}
            style={{ width: `${(part.minutes / safeTotal) * 100}%` }}
            className={cn(
              "flex min-w-0 items-center justify-center",
              part.kind === "service"
                ? "bg-accent-wash text-accent ring-1 ring-accent ring-inset"
                : "hatch-dense bg-surface-sunk text-ink-faint",
            )}
          >
            <span className="type-time truncate px-1">{part.minutes}</span>
          </div>
        ))}
      </div>

      <p className="type-body-sm text-ink-muted">
        <span className="text-ink">{blockedTimeSentence(timing)}</span>{" "}
        {parts.length > 1
          ? "Buffers are reserved on the calendar but never charged for and never shown to the customer."
          : "Add a buffer if you need time to reset between appointments."}
      </p>
    </div>
  );
}
