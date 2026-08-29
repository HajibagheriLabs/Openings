"use client";

import { CalendarClock, Plus } from "lucide-react";

import { Card, CardBody, CardHeader } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { PillButton } from "@/components/pill-button";
import { StatusBadge } from "@/components/status-badge";
import { formatDuration, formatInstantRange } from "@/components/time-text";
import { GAP_THRESHOLD_MIN } from "@/lib/admin/calendar";
import { formatCents } from "@/lib/money";
/* TYPES ONLY. That module reaches Temporal, which is server-only, so its
   values must never cross into the browser — see GAP_THRESHOLD_MIN above. */
import type {
  AgendaAppointment,
  DayGap,
  DaySummary,
} from "@/lib/scheduling/agenda";
import { cn } from "@/lib/utils";

/**
 * The numbers an owner actually looks at in the morning.
 *
 * Not a dashboard. Four facts and a list, chosen because each one changes what
 * somebody does in the next hour: how many people are coming, what the day is
 * worth, who is next, and where the holes are. Anything that would only be
 * interesting at the end of the month belongs somewhere else.
 *
 * EVERY NUMBER WAS COMPUTED ON THE SERVER (see `summariseDay`). This component
 * formats instants and cents and does no arithmetic of its own — including,
 * deliberately, no "in 20 minutes": a relative time has to be recomputed every
 * minute or it becomes a lie, and the appointment's real time never does.
 */
export function TodayPanel({
  summary,
  appointments,
  currency,
  timeZone,
  nowInstant,
  onOpenAppointment,
  onAddBooking,
  heading,
}: {
  summary: DaySummary;
  /** The day's appointments in start order, holds included. */
  appointments: AgendaAppointment[];
  currency: string;
  timeZone: string;
  /**
   * The server's clock at render.
   *
   * NOT `Date.now()`, and the reason is hydration: this component is rendered
   * on the server and then again in the browser, and a clock read on both
   * sides gives two different answers, so the row that dims itself for being
   * over would disagree with itself and React would tear the tree down. One
   * instant, sent down, used by both.
   */
  nowInstant: string;
  onOpenAppointment: (appointmentId: string) => void;
  /** Opens the manual booking sheet. The one action an empty day offers. */
  onAddBooking: () => void;
  /** "Today" on the day itself, the date otherwise. */
  heading: string;
}) {
  const nowMs = Date.parse(nowInstant);
  const next = summary.next;

  const drawn = appointments.filter(
    (appointment) =>
      appointment.status !== "cancelled" &&
      (appointment.status !== "held" || appointment.isLiveHold),
  );

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={heading}
          description={
            summary.bookedCount === 0
              ? "Nothing booked."
              : `${summary.bookedCount} appointment${
                  summary.bookedCount === 1 ? "" : "s"
                }${
                  summary.heldCount > 0
                    ? `, and ${summary.heldCount} slot${
                        summary.heldCount === 1 ? "" : "s"
                      } being held right now`
                    : ""
                }.`
          }
        />

        <CardBody className="flex flex-col gap-5">
          <dl className="grid grid-cols-2 gap-4">
            <Figure
              label="Booked"
              value={String(summary.bookedCount)}
              hint={
                summary.heldCount > 0
                  ? `+${summary.heldCount} held`
                  : undefined
              }
            />
            <Figure
              label="Expected"
              value={formatCents(summary.expectedRevenueCents, currency)}
              /* Said out loud, because "expected" is doing work: this is what
                 the day is worth if everybody turns up, and part of it is
                 already in the bank. */
              hint={
                summary.depositsTakenCents > 0
                  ? `${formatCents(
                      summary.depositsTakenCents,
                      currency,
                    )} already paid`
                  : "Nothing paid yet"
              }
            />
          </dl>

          <div className="flex flex-col gap-2 border-t border-line pt-4">
            <span className="type-label">Next</span>
            {next ? (
              <button
                type="button"
                onClick={() => onOpenAppointment(next.id)}
                className="flex flex-col items-start gap-1 rounded-card px-2 py-2 text-left transition-colors hover:bg-surface-sunk"
              >
                <span className="type-time-lg text-ink">
                  {formatInstantRange(next.startsAt, next.endsAt, timeZone)}
                </span>
                <span className="type-body-sm text-ink-muted">
                  {next.customerName ?? "Someone"} · {next.serviceName}
                </span>
              </button>
            ) : (
              <p className="type-body text-ink-muted">
                Nothing left today.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2 border-t border-line pt-4">
            <span className="type-label">
              Gaps over {GAP_THRESHOLD_MIN} minutes
            </span>
            {summary.gaps.length === 0 ? (
              <p className="type-body-sm text-ink-muted">
                No open stretches left worth filling.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {summary.gaps.map((gap) => (
                  <GapRow key={`${gap.staffId}-${gap.startsAt}`} gap={gap} timeZone={timeZone} />
                ))}
              </ul>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="The day, in order" />

        {drawn.length === 0 ? (
          <CardBody>
            <EmptyState
              icon={CalendarClock}
              title="Nothing in the diary"
              description="No appointments on this day yet. Customers can still book it, and you can put one in yourself."
              action={
                <PillButton size="sm" onClick={onAddBooking}>
                  <Plus aria-hidden="true" />
                  Add a booking
                </PillButton>
              }
              className="border-none bg-transparent px-0 py-4"
            />
          </CardBody>
        ) : (
          <ul className="divide-y divide-line">
            {drawn.map((appointment) => (
              <li key={appointment.id}>
                <button
                  type="button"
                  onClick={() => onOpenAppointment(appointment.id)}
                  className={cn(
                    "flex w-full min-h-11 items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-surface-sunk",
                    /* ═══ SUNK, NOT DIMMED ═══

                       The ribbon draws a past segment at 45% and that is right
                       THERE: a lapsed slot on the customer's picker is inert,
                       and WCAG exempts an inactive component from its contrast
                       rule precisely because there is nothing to act on.

                       This row is not inert. It is a button, and pressing it is
                       how the owner marks somebody a no-show — a decision made
                       only after the appointment did not happen. Opacity is the
                       wrong tool for an active control twice over: it puts both
                       lines under 4.5:1, and because opacity makes a group, the
                       status badge inside cannot opt back out of it.

                       So the row is CARVED instead of faded. --surface-sunk is
                       already this design system's word for material that has
                       been used up, it is the fill under every booked segment
                       on the ribbon, and it changes no text contrast at all. */
                    Date.parse(appointment.endsAt) < nowMs && "bg-surface-sunk",
                  )}
                >
                  <span className="type-time w-28 shrink-0 text-ink">
                    {formatInstantRange(
                      appointment.startsAt,
                      appointment.endsAt,
                      timeZone,
                    )}
                  </span>

                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="type-section truncate text-ink">
                      {appointment.customerName ?? "Not named yet"}
                    </span>
                    <span className="type-body-sm truncate text-ink-muted">
                      {appointment.serviceName}
                    </span>
                  </span>

                  <StatusBadge
                    tone={
                      appointment.status === "held"
                        ? "pending"
                        : appointment.status === "no_show"
                          ? "cancelled"
                          : appointment.status === "completed"
                            ? "neutral"
                            : "confirmed"
                    }
                  >
                    {STATUS_WORD[appointment.status]}
                  </StatusBadge>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

const STATUS_WORD: Record<AgendaAppointment["status"], string> = {
  held: "Held",
  confirmed: "Booked",
  completed: "Done",
  cancelled: "Cancelled",
  no_show: "No-show",
};

/**
 * One figure in the day's summary.
 *
 * The hint lives INSIDE the `<dd>`, not beside it. A `<div>` in a `<dl>` may
 * group one term with its descriptions and nothing else, so a stray `<p>` in
 * there is invalid — axe reports it, and it also leaves the hint orphaned from
 * the number it qualifies. Nested in the description it is read as part of the
 * same answer, which is what it is.
 */
function Figure({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="type-label">{label}</dt>
      <dd className="flex flex-col gap-1">
        <span className="type-time-lg text-ink">{value}</span>
        {hint ? (
          <span className="type-body-sm text-ink-faint">{hint}</span>
        ) : null}
      </dd>
    </div>
  );
}

function GapRow({ gap, timeZone }: { gap: DayGap; timeZone: string }) {
  return (
    <li className="type-body-sm flex items-baseline justify-between gap-3 text-ink-muted">
      <span className="type-time text-ink">
        {formatInstantRange(gap.startsAt, gap.endsAt, timeZone)}
      </span>
      <span className="truncate">
        {formatDuration(gap.minutes)} · {gap.staffName}
      </span>
    </li>
  );
}
