"use client";

import { useState } from "react";

import { BookingShell } from "@/components/booking/booking-shell";
import { DurationChip } from "@/components/duration-chip";
import { PillButton } from "@/components/pill-button";
import {
  Ribbon,
  RibbonLegend,
  type RibbonColumn,
  type RibbonSegment,
  type RibbonWindow,
} from "@/components/ribbon";
import {
  formatInstantDate,
  formatInstantRange,
  TimeText,
} from "@/components/time-text";
import { formatCents } from "@/lib/money";

/**
 * Choosing a time.
 *
 * NO BOOKING LOGIC LIVES HERE YET. Selecting a segment moves a local piece of
 * state and nothing else — it writes no hold, starts no countdown, and reserves
 * nothing. When holds land, `onSelectSegment` calls a Server Action, the
 * returned hold's remaining fraction feeds `holdRemaining` on the segment, and
 * the depleting bar the Ribbon already knows how to draw starts moving. The
 * component below does not change shape for that.
 */
export function DayPicker({
  business,
  service,
  day,
}: {
  business: { name: string; timezone: string; currency: string };
  service: { name: string; durationMin: number; priceCents: number };
  day: {
    window: RibbonWindow;
    columns: RibbonColumn[];
    nowMinute: number;
    todayInstant: string;
  };
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    // The demo day ships with one slot already held, so the summary bar and the
    // depleting bar both have something to show on first paint.
    () =>
      day.columns[0]?.segments.find(
        (segment) => segment.state === "selected",
      )?.id ?? null,
  );

  /**
   * The selection is applied on the way out to the Ribbon rather than mutated
   * into the data. The server owns what each segment IS; this only marks which
   * one the visitor is pointing at.
   */
  const columns: RibbonColumn[] = day.columns.map((column) => ({
    ...column,
    segments: column.segments.map((segment) => {
      if (segment.id === selectedId) {
        return { ...segment, state: "selected", holdRemaining: 0.62 };
      }

      return segment.state === "selected"
        ? { ...segment, state: "open", holdRemaining: undefined }
        : segment;
    }),
  }));

  const selected = columns
    .flatMap((column) => column.segments)
    .find((segment) => segment.id === selectedId);

  function choose(segment: RibbonSegment) {
    setSelectedId((current) => (current === segment.id ? null : segment.id));
  }

  return (
    <BookingShell
      businessName={business.name}
      step={2}
      totalSteps={4}
      summary={
        selected ? (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <p className="type-label">Your slot</p>
              <p className="type-time-lg truncate text-ink">
                {formatInstantRange(
                  selected.startsAt,
                  selected.endsAt,
                  business.timezone,
                )}
              </p>
            </div>

            <PillButton>Continue</PillButton>
          </div>
        ) : (
          <p className="type-body text-ink-muted">
            Pick a time to get started. Nothing is held until you do.
          </p>
        )
      }
    >
      <header className="flex flex-col gap-3">
        <h1 className="type-page-title text-ink">Pick a time</h1>

        <div className="flex flex-wrap items-center gap-3">
          <span className="type-section text-ink">{service.name}</span>
          <DurationChip minutes={service.durationMin} />
          <span className="type-time text-ink-muted">
            {formatCents(service.priceCents, business.currency)}
          </span>
        </div>

        <p className="type-body text-ink-muted">
          Times are shown in {business.timezone.replace(/_/g, " ")}. Choosing one
          holds it for 8 minutes while you fill in your details.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="type-section text-ink">
          {formatInstantDate(day.todayInstant, business.timezone)}
        </h2>

        <Ribbon
          window={day.window}
          columns={columns}
          timeZone={business.timezone}
          nowMinute={day.nowMinute}
          onSelectSegment={choose}
          hideColumnHeaders
          ariaLabel={`Times available on ${formatInstantDate(
            day.todayInstant,
            business.timezone,
          )}`}
        />
      </section>

      {selected ? (
        <p className="type-body-sm text-ink-muted">
          You picked{" "}
          <TimeText
            instant={selected.startsAt}
            timeZone={business.timezone}
            className="text-ink"
          />
          . Press it again to let it go.
        </p>
      ) : null}

      <RibbonLegend states={["open", "selected", "held", "booked"]} />
    </BookingShell>
  );
}
