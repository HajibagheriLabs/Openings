"use client";

import { CalendarOff, ChevronLeft, ChevronRight, List, Rows3 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { SlotList } from "@/components/booking/slot-list";
import { PillButton } from "@/components/pill-button";
import { Ribbon, RibbonLegend, type RibbonSegment } from "@/components/ribbon";
import { formatInstantDate, formatInstantRange } from "@/components/time-text";
import type { RescheduleResult } from "@/lib/booking/manage-actions";
import type { DayView } from "@/lib/scheduling/day-view";
import { loadRescheduleDay, rescheduleBooking } from "@/server/actions/manage";

/**
 * Moving an appointment, on the same strip of material it was booked on.
 *
 * ═══ THE SAME RIBBON, SCOPED BY THE SERVER ═══
 *
 * This is the picker from the booking flow, drawing the same `DayView` at the
 * same scale — but it never says which service or which staff member it wants.
 * Both come off the appointment, on the server, inside the action. A picker
 * that could name them would be a picker that could browse anybody's diary
 * with one leaked link.
 *
 * ═══ AND THERE IS NO HOLD ═══
 *
 * The booking flow takes a `held` row the instant somebody taps a time, because
 * a stranger picking a slot has nothing else reserving it. Here the customer
 * ALREADY HAS an appointment: they are not acquiring time, they are asking for
 * theirs to be somewhere else. Taking a hold would mean briefly occupying two
 * slots and then needing a second step to reconcile them — and if that second
 * step failed, the customer would be the one holding the mess.
 *
 * So the tap selects, and the button moves, and the move is one atomic UPDATE
 * that either lands on the new time or leaves the appointment exactly where it
 * was. See `moveAppointment`. The worst outcome of a lost race here is a
 * message saying so, with the day redrawn underneath it.
 */
export function ReschedulePicker({
  token,
  initialDay,
  currentStartsAt,
  onMoved,
  onCancel,
}: {
  token: string;
  initialDay: DayView;
  /** Where the appointment is now, so the strip can mark it. */
  currentStartsAt: string;
  onMoved: (startsAt: string, endsAt: string) => void;
  onCancel: () => void;
}) {
  const [day, setDay] = useState(initialDay);
  const [chosen, setChosen] = useState<string | null>(null);
  const [view, setView] = useState<"ribbon" | "list">("ribbon");
  const [pending, startTransition] = useTransition();

  function goToDay(date: string) {
    setChosen(null);

    startTransition(async () => {
      const result = await loadRescheduleDay(token, date);

      if (result.ok) {
        setDay(result.day);
        return;
      }

      toast.error(result.message);
    });
  }

  function move() {
    if (!chosen) {
      return;
    }

    startTransition(async () => {
      const result: RescheduleResult = await rescheduleBooking(token, chosen);

      if (result.ok) {
        onMoved(result.startsAt, result.endsAt);
        return;
      }

      /* A lost race redraws the truth in the same breath as it reports it —
         the customer wanted a time near that one and is owed the day as it
         actually stands, not an error over a stale drawing. */
      if (result.day) {
        setDay(result.day);
      }

      setChosen(null);
      toast.error(result.message);
    });
  }

  const dayLabel = formatInstantDate(day.dayInstant, day.timeZone);

  const segments: RibbonSegment[] = [
    ...day.blocks.map((block) => ({
      id: block.id,
      state: block.kind === "busy" ? ("booked" as const) : ("blocked" as const),
      startMinute: block.startMinute,
      durationMin: block.durationMin,
      startsAt: block.startsAt,
      endsAt: block.endsAt,
      label: block.kind === "busy" ? "Booked" : "Closed",
      isPast:
        day.nowMinute !== null &&
        block.startMinute + block.durationMin <= day.nowMinute,
    })),

    ...day.offers.map((offer) => {
      const isChosen = chosen === offer.startsAt;
      /* Where the appointment sits today. Marked, but still tappable — moving
         to the time you are already on is a no-op the server answers with a
         shrug rather than an error. */
      const isCurrent = offer.startsAt === currentStartsAt;

      return {
        id: offer.id,
        state: isChosen ? ("selected" as const) : ("open" as const),
        startMinute: offer.startMinute,
        durationMin: offer.durationMin,
        startsAt: offer.startsAt,
        endsAt: offer.endsAt,
        label: isChosen ? "Moving here" : isCurrent ? "Now" : undefined,
        disabled: pending,
      };
    }),
  ];

  const previousDate = shiftDate(day.date, -1);
  const nextDate = shiftDate(day.date, 1);

  return (
    <section className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <PillButton
          type="button"
          variant="quiet"
          size="sm"
          onClick={() => goToDay(previousDate)}
          disabled={pending}
          aria-label="Previous day"
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
        </PillButton>

        <p className="type-section text-ink">{dayLabel}</p>

        <PillButton
          type="button"
          variant="quiet"
          size="sm"
          onClick={() => goToDay(nextDate)}
          disabled={pending}
          aria-label="Next day"
        >
          <ChevronRight aria-hidden="true" className="size-4" />
        </PillButton>
      </div>

      {day.closed || day.offers.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-line bg-surface px-6 py-10 text-center">
          <CalendarOff aria-hidden="true" className="size-5 text-ink-faint" />
          <p className="type-body text-ink-muted">
            {day.closed
              ? "They are closed this day."
              : "Nothing free this day. Try another."}
          </p>
        </div>
      ) : (
        <>
          <div className="flex justify-end">
            <PillButton
              type="button"
              variant="quiet"
              size="sm"
              onClick={() => setView(view === "ribbon" ? "list" : "ribbon")}
            >
              {view === "ribbon" ? (
                <List aria-hidden="true" className="size-4" />
              ) : (
                <Rows3 aria-hidden="true" className="size-4" />
              )}
              {view === "ribbon" ? "As a list" : "As a strip"}
            </PillButton>
          </div>

          {view === "ribbon" ? (
            <Ribbon
              window={day.window}
              columns={[{ id: day.date, label: dayLabel, segments }]}
              timeZone={day.timeZone}
              nowMinute={day.nowMinute ?? undefined}
              hideColumnHeaders
              ariaLabel={`Times available on ${dayLabel}`}
              onSelectSegment={(segment) => {
                if (segment.state === "open" || segment.state === "selected") {
                  setChosen(segment.startsAt ?? null);
                }
              }}
            />
          ) : (
            <SlotList
              day={day}
              selectedStartsAt={chosen}
              pendingStartsAt={null}
              onSelect={(offer) => setChosen(offer.startsAt)}
            />
          )}

          {/* Scoped to the states this picker can actually produce. The
              booking flow's "held for you" entry is deliberately left out:
              there is no hold here, and a legend explaining a state the strip
              will never show is a legend that teaches the wrong thing. The
              chosen segment labels itself "Moving here". */}
          <RibbonLegend states={["open", "booked", "blocked"]} />
        </>
      )}

      <div className="flex flex-wrap gap-3">
        <PillButton type="button" onClick={move} disabled={!chosen || pending}>
          {chosen
            ? `Move to ${formatInstantRange(
                chosen,
                endOfChosen(day, chosen) ?? chosen,
                day.timeZone,
              )}`
            : "Pick a new time"}
        </PillButton>

        <PillButton
          type="button"
          variant="secondary"
          onClick={onCancel}
          disabled={pending}
        >
          Keep the time I have
        </PillButton>
      </div>
    </section>
  );
}

/** The chosen offer's end, so the button can name the whole span. */
function endOfChosen(day: DayView, startsAt: string): string | null {
  return day.offers.find((offer) => offer.startsAt === startsAt)?.endsAt ?? null;
}

/**
 * The neighbouring calendar date.
 *
 * `Date.UTC` on the date PARTS, not on the instant: "2026-09-03" is a label,
 * not a moment, and stepping it by a day is string arithmetic on the calendar
 * rather than time arithmetic on a clock. Doing it the other way is how a day
 * button skips 30 March in a zone that springs forward — and it is why every
 * real instant in this product is computed on the server instead.
 */
function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const stepped = new Date(Date.UTC(year, month - 1, day + days));

  return stepped.toISOString().slice(0, 10);
}
