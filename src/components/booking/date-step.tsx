"use client";

import { CalendarOff } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useMemo, useTransition } from "react";

import { BookingShell } from "@/components/booking/booking-shell";
import { StepHeading } from "@/components/booking/step-heading";
import { PillButton } from "@/components/pill-button";
import { formatInstant, formatInstantDate } from "@/components/time-text";
import { Calendar } from "@/components/ui/calendar";
import { bookingUrl } from "@/lib/booking/url";
import type { MonthSummary } from "@/lib/scheduling/month-summary";

/**
 * Step 3 — which day.
 *
 * ONE REQUEST PER MONTH, NOT ONE PER DAY. The whole month arrives as a list of
 * `{ date, openings }` computed by a single availability call on the server,
 * so this component never asks a question — it renders an answer it was
 * handed. A day with nothing free is disabled and quiet; a day with something
 * free carries the same accent wash and hairline border that open time carries
 * on the ribbon, so the calendar and the day agree about what an opening looks
 * like before anyone has read a word.
 *
 * A month change is a NAVIGATION, not a fetch. The month is in the URL, the
 * server renders the next month's availability, and back goes back. The
 * transition is marked so the grid can go quiet while it happens rather than
 * flashing a spinner or, worse, showing last month's disabled days under this
 * month's numbers.
 *
 * The only client-side date work here is formatting instants the server sent.
 * Which days are open, how far ahead the calendar may go and what "today"
 * means were all decided in the business's timezone, on the server, before
 * this file saw them.
 */
export function DateStep({
  slug,
  serviceId,
  staffId,
  summary,
  unavailableDate,
  step,
  totalSteps,
  header,
  choices,
}: {
  slug: string;
  serviceId: string;
  /** Null when the business has one qualified person and the step was skipped. */
  staffId: string | null;
  summary: MonthSummary;
  /**
   * A day the visitor asked for that has nothing left, already formatted for
   * reading. Null in the ordinary case, where they simply have not chosen yet.
   */
  unavailableDate: string | null;
  step: number;
  totalSteps: number;
  header: ReactNode;
  choices: ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  /** Local dates with at least one opening. Everything else is disabled. */
  const openDates = useMemo(
    () =>
      new Set(
        summary.days.filter((day) => day.openings > 0).map((day) => day.date),
      ),
    [summary.days],
  );

  function go(next: { month: string; date?: string }) {
    startTransition(() => {
      router.push(
        bookingUrl(slug, {
          service: serviceId,
          staff: staffId ?? undefined,
          month: next.month,
          date: next.date,
        }),
        // The calendar sits mid-page. Jumping to the top on every month change
        // would move the thing being tapped out from under the thumb.
        { scroll: false },
      );
    });
  }

  const nextOpen = summary.nextOpen;

  return (
    <BookingShell
      step={step}
      totalSteps={totalSteps}
      header={header}
      choices={choices}
    >
      <section className="flex flex-col gap-5">
        <StepHeading
          eyebrow="Day"
          title="Pick a day"
          description="Days with nothing free are greyed out."
        />

        {unavailableDate ? (
          /* Says what happened and what to do, and blames nobody: the link
             was fine when it was sent. Deliberately not "any more" — the day
             may have filled up, or may never have been open at all, and from
             out here those are the same fact. */
          <p
            role="status"
            className="type-body rounded-card border border-line bg-surface-sunk px-4 py-3 text-ink"
          >
            {unavailableDate} has nothing free. Pick another day below.
          </p>
        ) : null}

        <div className="rounded-card border border-line bg-surface p-3">
          <Calendar
            timeZone={summary.timeZone}
            month={summary.month}
            onMonthChange={(month) => go({ month })}
            /* Choosing a day advances the flow, so there is never a chosen day
               still sitting on this screen — arriving here means the choice is
               yet to be made, or was dropped because that day has nothing. */
            selected={null}
            onSelect={(date) => go({ month: summary.month, date })}
            isDisabled={(date) => !openDates.has(date)}
            firstMonth={summary.horizon.firstMonth}
            lastMonth={summary.horizon.lastMonth}
            busy={pending}
            ariaLabel="Days with openings"
          />
        </div>

        {summary.openings === 0 ? (
          <div className="flex flex-col items-start gap-4 rounded-card border border-dashed border-line bg-surface px-5 py-6">
            <CalendarOff aria-hidden="true" className="size-5 text-ink-faint" />

            <div className="flex flex-col gap-2">
              <p className="type-section text-ink">
                Nothing free this month
              </p>
              <p className="type-body text-ink-muted">
                {nextOpen
                  ? `The next opening is ${formatInstantDate(
                      nextOpen.startsAt,
                      summary.timeZone,
                    )} at ${formatInstant(nextOpen.startsAt, summary.timeZone)}.`
                  : "There is nothing free between now and as far ahead as this business takes bookings. Get in touch and they will find you a time."}
              </p>
            </div>

            {/* The shortcut moves the CALENDAR, it does not make the choice.
                Landing somebody on a day they never tapped would be faster and
                would take the decision off them. */}
            {nextOpen ? (
              <PillButton
                variant="secondary"
                onClick={() => go({ month: nextOpen.month })}
              >
                {`Show ${formatInstant(nextOpen.startsAt, summary.timeZone, {
                  month: "long",
                })}`}
              </PillButton>
            ) : null}
          </div>
        ) : null}
      </section>
    </BookingShell>
  );
}
