"use client";

import { CalendarDays } from "lucide-react";
import Link from "next/link";

import { pillButtonVariants } from "@/components/pill-button";
import { StatusBadge } from "@/components/status-badge";
import { formatInstantDate, formatInstantRange } from "@/components/time-text";
import type { ConflictingAppointment } from "@/server/queries/hours";

/**
 * The appointments a closure would sit on top of.
 *
 * A WARNING, NOT A REFUSAL. The owner is allowed to block time they are
 * already booked in — that is what happens when somebody is ill. What they are
 * not allowed to do is block it without knowing, which is why this lists every
 * one by name and time rather than saying "3 conflicts".
 *
 * The appointments themselves are NOT touched. Blocking time stops new
 * bookings; it does not cancel anybody. The link goes to the agenda, where
 * moving or cancelling one is a deliberate act with a customer email attached.
 */
export function ConflictList({
  conflicts,
  timeZone,
}: {
  conflicts: ConflictingAppointment[];
  timeZone: string;
}) {
  if (conflicts.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3 rounded-card border border-pending/40 bg-pending/10 p-4">
      <div className="flex flex-col gap-1">
        <p className="type-section text-pending">
          {conflicts.length === 1
            ? "One appointment is already inside this time"
            : `${conflicts.length} appointments are already inside this time`}
        </p>
        <p className="type-body-sm text-ink-muted">
          Blocking the time does not cancel them. They stay in the calendar and
          still need doing — or moving.
        </p>
      </div>

      <ul className="flex flex-col gap-2">
        {conflicts.map((appointment) => (
          <li
            key={appointment.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-line bg-surface px-3 py-2"
          >
            <span className="type-time text-ink">
              {formatInstantRange(
                appointment.startsAt,
                appointment.endsAt,
                timeZone,
              )}
            </span>

            <span className="type-body-sm text-ink-muted">
              {formatInstantDate(appointment.startsAt, timeZone)}
            </span>

            <span className="type-body-sm text-ink">
              {appointment.customerName}
            </span>

            <span className="type-body-sm text-ink-muted">
              {appointment.serviceName} · {appointment.staffName}
            </span>

            <StatusBadge
              tone={appointment.status === "confirmed" ? "confirmed" : "pending"}
              className="ml-auto"
            >
              {appointment.status === "confirmed" ? "Confirmed" : "Held"}
            </StatusBadge>
          </li>
        ))}
      </ul>

      <Link
        href="/admin/calendar"
        className={pillButtonVariants({ variant: "secondary", size: "sm" })}
      >
        <CalendarDays aria-hidden="true" />
        Open the agenda
      </Link>
    </div>
  );
}
