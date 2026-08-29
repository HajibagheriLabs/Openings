"use client";

import { Check, Loader2 } from "lucide-react";

import {
  formatCountdown,
  type HoldCountdown,
} from "@/components/booking/use-hold-countdown";
import { formatDuration, formatInstantRange } from "@/components/time-text";
import type { DayOffer, DayView } from "@/lib/scheduling/day-view";
import { cn } from "@/lib/utils";

/**
 * The same day, as a list.
 *
 * WHY IT EXISTS. The Ribbon draws time to scale, which is what makes the day
 * legible — and which also makes a fourteen-hour day a long scroll, and makes
 * a 15-minute slot 24px tall. Neither is a problem worth solving on the strip
 * itself: shrinking the scale would break the proportionality the whole
 * component is for. So there is a second reading of the same data, where every
 * row is the same height, the times are in one column, and a screen reader or
 * a switch user meets a plain list of buttons instead of a positioned grid.
 *
 * DRIVEN BY THE SAME DATA, and that is not a coincidence — it takes the same
 * `DayView` the Ribbon takes, offers the same `offers`, and calls the same
 * handler. There is no second availability query and no second idea of what is
 * bookable, so the two views cannot disagree about the day.
 *
 * The taken time is not merely absent here either: it is counted in a line at
 * the end, because "four times left out of eleven" is the same fact the
 * hatching carries on the strip.
 */
export function SlotList({
  day,
  selectedStartsAt,
  pendingStartsAt,
  countdown,
  onSelect,
  className,
}: {
  day: DayView;
  /** The offer this visitor is holding, if any. */
  selectedStartsAt: string | null;
  /** The offer whose hold is being written right now. */
  pendingStartsAt: string | null;
  /**
   * The hold's remaining time, when there IS a hold.
   *
   * OPTIONAL, because this list is shared with the reschedule picker on the
   * manage page — and a customer moving an appointment they already have is
   * not holding anything. There is nothing to count down, so the bar, the
   * readout and the "held for you" announcement are all simply absent rather
   * than showing a timer against nothing.
   */
  countdown?: HoldCountdown;
  onSelect: (offer: DayOffer) => void;
  className?: string;
}) {
  const takenCount = day.blocks.filter((block) => block.kind === "busy").length;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <ul className="flex flex-col gap-2">
        {day.offers.map((offer) => {
          const selected = offer.startsAt === selectedStartsAt;
          const pending = offer.startsAt === pendingStartsAt;

          return (
            <li key={offer.id}>
              <button
                type="button"
                onClick={() => onSelect(offer)}
                aria-pressed={selected}
                disabled={pending}
                className={cn(
                  "relative flex min-h-11 w-full items-center gap-3 overflow-hidden rounded-pill border px-4 py-2 text-left",
                  selected
                    ? "border-accent bg-accent text-accent-contrast"
                    : "border-accent bg-accent-wash text-ink hover:bg-accent/15",
                  pending && "opacity-70",
                )}
              >
                {selected && countdown ? (
                  /* The same depleting bar the strip draws, on the same
                     fraction of the same hold. */
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-accent-contrast/25"
                  >
                    <span
                      className="hold-bar block h-full bg-accent-contrast"
                      style={{ width: `${countdown.fraction * 100}%` }}
                    />
                  </span>
                ) : null}

                <span className="type-time flex-1">
                  {formatInstantRange(
                    offer.startsAt,
                    offer.endsAt,
                    day.timeZone,
                  )}
                </span>

                <span
                  className={cn(
                    "type-body-sm",
                    selected ? "text-accent-contrast/80" : "text-ink-muted",
                  )}
                >
                  {formatDuration(offer.durationMin)}
                </span>

                {pending ? (
                  <Loader2
                    aria-hidden="true"
                    className="size-4 shrink-0 animate-spin"
                  />
                ) : selected ? (
                  <span className="flex shrink-0 items-center gap-2">
                    {countdown ? (
                      <span className="type-time tabular">
                        {formatCountdown(countdown.secondsRemaining)}
                      </span>
                    ) : null}
                    <Check aria-hidden="true" className="size-4" />
                  </span>
                ) : null}

                {selected ? (
                  <span className="sr-only">
                    {countdown
                      ? `Held for you, ${countdown.secondsRemaining} seconds left`
                      : "Selected"}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>

      {takenCount > 0 ? (
        <p className="type-body-sm text-ink-faint">
          {takenCount === 1
            ? "One appointment is already in this day."
            : `${takenCount} appointments are already in this day.`}
        </p>
      ) : null}
    </div>
  );
}
