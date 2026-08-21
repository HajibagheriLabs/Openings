"use client";

import { Ribbon, type RibbonColumn } from "@/components/ribbon";
import {
  splitIntoDaySpans,
  weekWindow,
  WEEKDAYS_DISPLAY_ORDER,
  WEEKDAY_NAMES,
  type LocalInterval,
} from "@/lib/scheduling/week";

/**
 * The week the owner just configured, drawn by the Ribbon.
 *
 * NO INSTANTS, AND NO TIMEZONE MATH — which is why this one can run on the
 * client while the time-off preview cannot. A weekly pattern is wall-clock
 * minutes and nothing else: "Monday 09:00–17:00" needs no date to be drawn to
 * scale, and inventing one would be inventing a fact. The segments therefore
 * carry `startMinute` and `durationMin` only, and the Ribbon labels them off
 * the clock face. See the note on RibbonSegment.startsAt.
 *
 * Being instant-free is also what makes it live: the preview redraws as the
 * grid is typed, with no round trip and no debounce, because there is nothing
 * to ask the server about.
 *
 * A MIDNIGHT-CROSSING SHIFT SHOWS UP AS TWO PIECES, in the two days it
 * genuinely occupies. That is the whole argument for supporting them visually
 * rather than in prose: an owner who types 22:00–02:00 sees Tuesday morning
 * fill in, and immediately understands why a Tuesday 01:00 rule was rejected.
 */
export function WeekPreview({
  intervals,
  title = "The week you have configured",
  timeZone,
}: {
  intervals: LocalInterval[];
  title?: string;
  /** For the Ribbon's label formatting only. No arithmetic uses it here. */
  timeZone: string;
}) {
  const spans = splitIntoDaySpans(intervals);
  const window = weekWindow(spans);

  const columns: RibbonColumn[] = WEEKDAYS_DISPLAY_ORDER.map((weekday) => {
    const day = WEEKDAY_NAMES[weekday];
    const daySpans = spans.filter((span) => span.weekday === weekday);

    return {
      id: String(weekday),
      label: day.short,
      sublabel:
        daySpans.length === 0
          ? "Closed"
          : `${Math.round(
              daySpans.reduce((total, span) => total + span.durationMin, 0) / 6,
            ) / 10} h`,
      segments: daySpans.map((span, index) => ({
        id: `${weekday}-${index}`,
        // Open time is the one thing the accent means. A configured hour IS
        // open time, so the preview uses exactly the same encoding the
        // customer's picker will.
        state: "open" as const,
        startMinute: span.startMinute,
        durationMin: span.durationMin,
        label: span.isContinuation ? `${span.label} (from ${previousDayShort(weekday)})` : undefined,
      })),
    };
  });

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="type-section text-ink">{title}</h3>
        <p className="type-body-sm text-ink-faint">
          Drawn to scale, in {timeZone.replace(/_/g, " ")} local time
        </p>
      </div>

      <Ribbon
        window={window}
        columns={columns}
        timeZone={timeZone}
        ariaLabel="Preview of the configured week"
      />
    </section>
  );
}

/** "Mon", for labelling the tail of a shift that started the day before. */
function previousDayShort(weekday: number): string {
  return WEEKDAY_NAMES[(weekday + 6) % 7].short;
}
