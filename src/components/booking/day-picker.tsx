"use client";

import type { ReactNode } from "react";
import { useState } from "react";

import { BookingShell } from "@/components/booking/booking-shell";
import { StepHeading } from "@/components/booking/step-heading";
import { PillButton } from "@/components/pill-button";
import {
  isDatedSegment,
  Ribbon,
  RibbonLegend,
  type RibbonColumn,
  type RibbonSegment,
  type RibbonWindow,
} from "@/components/ribbon";
import {
  formatDuration,
  formatInstantDate,
  formatInstantRange,
  TimeText,
} from "@/components/time-text";
import { formatCents } from "@/lib/money";

/**
 * Step 4 — which time.
 *
 * THE SEGMENTS ARE STILL DEMO DATA. The day, the service, the staff member and
 * the business's timezone are all real and all resolved on the server; what is
 * not yet real is the list of free slots inside the chosen day, which is the
 * work the holds land with. Selecting a segment moves a local piece of state
 * and nothing else — it writes no hold, starts no countdown, and reserves
 * nothing.
 *
 * When holds arrive, `onSelectSegment` calls a Server Action, the returned
 * hold's remaining fraction feeds `holdRemaining` on the segment, and the
 * depleting bar the Ribbon already knows how to draw starts moving. The
 * component below does not change shape for that.
 */
export function DayPicker({
  business,
  service,
  day,
  step,
  totalSteps,
  header,
  choices,
}: {
  business: { name: string; timezone: string; currency: string };
  service: { name: string; durationMin: number; priceCents: number };
  day: {
    window: RibbonWindow;
    columns: RibbonColumn[];
    nowMinute: number | null;
    dayInstant: string;
  };
  step: number;
  totalSteps: number;
  header: ReactNode;
  choices: ReactNode;
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

  /**
   * Narrowed to a dated segment: the summary below shows a real time, and a
   * pattern has none. A day picker never receives one, and the compiler now
   * knows that rather than being told.
   */
  const selected = columns
    .flatMap((column) => column.segments)
    .filter(isDatedSegment)
    .find((segment) => segment.id === selectedId);

  function choose(segment: RibbonSegment) {
    setSelectedId((current) => (current === segment.id ? null : segment.id));
  }

  const dayLabel = formatInstantDate(day.dayInstant, business.timezone);

  return (
    <BookingShell
      step={step}
      totalSteps={totalSteps}
      header={header}
      choices={choices}
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
      <section className="flex flex-col gap-5">
        <StepHeading
          eyebrow="Time"
          title="Pick a time"
          description={`${dayLabel}. ${service.name}, ${formatDuration(
            service.durationMin,
          )}, ${formatCents(
            service.priceCents,
            business.currency,
          )}. Choosing a time holds it for 8 minutes while you fill in your details.`}
        />

        <Ribbon
          window={day.window}
          columns={columns}
          timeZone={business.timezone}
          nowMinute={day.nowMinute}
          onSelectSegment={choose}
          hideColumnHeaders
          ariaLabel={`Times available on ${dayLabel}`}
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
