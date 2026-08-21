"use client";

import { CalendarOff, Plus, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { PillButton } from "@/components/pill-button";
import { StatusBadge } from "@/components/status-badge";
import {
  formatInstantDate,
  formatInstantRange,
} from "@/components/time-text";
import { cn } from "@/lib/utils";
import { deleteTimeOff } from "@/server/actions/time-off";
import type { TimeOffEntry } from "@/server/queries/hours";

import { TimeOffSheet, type TimeOffStaffOption } from "./time-off-sheet";

/**
 * Holidays, closures and afternoons off.
 *
 * Everything here is a concrete instant range, unlike the weekly hours next
 * door — which is why every time on this screen is formatted from an ISO
 * instant the server sent, and why nothing on it computes a date.
 *
 * Recurring closures are deliberately absent. The seam for them is documented
 * in src/lib/scheduling/time-off.ts; what is not here is a half-built version
 * of it.
 */
export function TimeOffManager({
  entries,
  staff,
  timeZone,
  today,
}: {
  entries: TimeOffEntry[];
  staff: TimeOffStaffOption[];
  timeZone: string;
  today: string;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<TimeOffEntry | null>(
    null,
  );
  const [pending, startTransition] = useTransition();

  const upcoming = entries.filter((entry) => !entry.isPast);
  const past = entries.filter((entry) => entry.isPast);

  function remove(entry: TimeOffEntry): void {
    setConfirmingDelete(null);

    startTransition(async () => {
      const result = await deleteTimeOff(entry.id);

      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Time off"
        title="Blocked time"
        description="Holidays, closures and one-off absences. Blocked time is subtracted from availability on top of the weekly hours — it never cancels an appointment that is already booked."
        actions={
          <PillButton onClick={() => setSheetOpen(true)}>
            <Plus aria-hidden="true" />
            Block out time
          </PillButton>
        }
      />

      {entries.length === 0 ? (
        <EmptyState
          icon={CalendarOff}
          title="Nothing blocked out"
          description="Block a range when the shop is shut or somebody is away. Weekly hours say when you are normally open; this is where the exceptions go."
          action={
            <PillButton onClick={() => setSheetOpen(true)}>
              <Plus aria-hidden="true" />
              Block out time
            </PillButton>
          }
        />
      ) : (
        <div className="flex flex-col gap-8">
          <TimeOffSection
            title="Coming up"
            entries={upcoming}
            emptyMessage="Nothing blocked ahead."
            timeZone={timeZone}
            busy={pending}
            onDelete={setConfirmingDelete}
          />

          {past.length > 0 ? (
            <TimeOffSection
              title="Past"
              entries={past}
              emptyMessage=""
              timeZone={timeZone}
              busy={pending}
              onDelete={setConfirmingDelete}
            />
          ) : null}
        </div>
      )}

      <TimeOffSheet
        // A fresh form per opening, seeded from current data. Same reasoning as
        // the service and staff sheets.
        key={String(sheetOpen)}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        staff={staff}
        timeZone={timeZone}
        today={today}
      />

      <ConfirmDialog
        open={confirmingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmingDelete(null);
          }
        }}
        title="Unblock this time?"
        description="The range becomes bookable again from now on. Appointments that were already in it were never touched, so nothing about them changes."
        confirmLabel="Unblock"
        cancelLabel="Keep it blocked"
        destructive
        onConfirm={() => {
          if (confirmingDelete) {
            remove(confirmingDelete);
          }
        }}
      />
    </div>
  );
}

function TimeOffSection({
  title,
  entries,
  emptyMessage,
  timeZone,
  busy,
  onDelete,
}: {
  title: string;
  entries: TimeOffEntry[];
  emptyMessage: string;
  timeZone: string;
  busy: boolean;
  onDelete: (entry: TimeOffEntry) => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="type-label">{title}</h2>

      {entries.length === 0 ? (
        <p className="type-body-sm rounded-card border border-dashed border-line px-4 py-3 text-ink-muted">
          {emptyMessage}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className={cn(
                "flex flex-wrap items-start justify-between gap-x-4 gap-y-3 rounded-card border border-line bg-surface p-4",
                entry.isPast && "opacity-60",
              )}
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="type-time text-ink">
                    {describeSpan(entry, timeZone)}
                  </span>

                  {entry.isAllDay ? (
                    <StatusBadge tone="neutral">
                      {entry.dayCount === 1
                        ? "All day"
                        : `${entry.dayCount} days`}
                    </StatusBadge>
                  ) : null}
                </div>

                <p className="type-body-sm text-ink-muted">
                  {entry.staffName ?? "The whole business"}
                  {entry.reason ? ` · ${entry.reason}` : ""}
                </p>
              </div>

              <PillButton
                variant="quiet"
                size="icon-sm"
                disabled={busy}
                onClick={() => onDelete(entry)}
                aria-label={`Unblock ${describeSpan(entry, timeZone)}`}
              >
                <Trash2 aria-hidden="true" />
              </PillButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * How a blocked range reads.
 *
 * An all-day block is described by its DAYS, never by its instants: saying
 * "25 December 00:00 – 26 December 00:00" is technically what is stored and is
 * exactly the confusion the local-day resolution exists to spare the owner.
 * A part-day block shows the real times, in the business's zone.
 */
function describeSpan(entry: TimeOffEntry, timeZone: string): string {
  if (entry.isAllDay) {
    const first = formatInstantDate(entry.startsAt, timeZone);

    if (entry.dayCount <= 1) {
      return first;
    }

    /**
     * The stored upper bound is EXCLUSIVE — the start of the day after the
     * last one — so the last day shown has to come from one millisecond
     * inside the range. Formatting the bound itself would name a day the
     * closure does not cover.
     */
    const lastMoment = new Date(new Date(entry.endsAt).getTime() - 1);

    return `${first} – ${formatInstantDate(
      lastMoment.toISOString(),
      timeZone,
    )}`;
  }

  return `${formatInstantDate(entry.startsAt, timeZone)}, ${formatInstantRange(
    entry.startsAt,
    entry.endsAt,
    timeZone,
  )}`;
}
