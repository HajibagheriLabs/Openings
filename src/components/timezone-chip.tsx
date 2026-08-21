import { Globe } from "lucide-react";

import { formatTimeZoneAbbreviation } from "@/components/time-text";
import { cn } from "@/lib/utils";

/**
 * The zone every time on the screen is expressed in, always visible.
 *
 * This product is about time, and the single most expensive mistake it can
 * make is showing someone a time in a zone they did not expect. A business
 * owner on holiday in another country still has to read their agenda in the
 * SHOP's hours, so the chip stays in the top bar permanently rather than
 * hiding in settings.
 *
 * The abbreviation ("CEST") is what a person recognises; the identifier
 * ("Europe/Berlin") is what the system means, and it goes in the title and the
 * accessible name so the two are never confused.
 */
export function TimezoneChip({
  timeZone,
  /** Any instant inside the current offset — abbreviations move with DST. */
  instant,
  className,
}: {
  timeZone: string;
  instant: string;
  className?: string;
}) {
  const abbreviation = formatTimeZoneAbbreviation(instant, timeZone);
  const readable = timeZone.replace(/_/g, " ");

  return (
    <span
      title={readable}
      className={cn(
        "type-body-sm inline-flex h-8 items-center gap-2 rounded-pill border border-line bg-surface-sunk px-3 text-ink-muted",
        className,
      )}
    >
      <Globe aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="sr-only">Times shown in</span>
      <span className="type-time">{abbreviation}</span>
      <span className="hidden truncate sm:inline">{readable}</span>
    </span>
  );
}
