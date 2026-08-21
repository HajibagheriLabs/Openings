"use client";

import { CalendarClock, Plus, Trash2, Users } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { AssignmentPicker } from "@/components/assignment-picker";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Field, FormError } from "@/components/field";
import { PageHeader } from "@/components/page-header";
import { PillButton } from "@/components/pill-button";
import { StatusBadge } from "@/components/status-badge";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { formatDuration } from "@/components/time-text";
import type { LocalInterval } from "@/lib/scheduling/week";
import { weeklyHoursSchema } from "@/lib/validation/hours";
import { cn } from "@/lib/utils";
import {
  copyWeekToStaff,
  deleteHoursVersion,
  saveWeeklyHours,
} from "@/server/actions/hours";
import type { HoursVersion, StaffHours } from "@/server/queries/hours";

import { WeekEditor, type EditorDay } from "./week-editor";
import { WeekPreview } from "./week-preview";

/**
 * Opening hours, per staff member, as dated versions.
 *
 * THE SCREEN'S ONE IDEA: you never edit the past. A version that has already
 * started governed real days — days customers booked against — so changing it
 * would retroactively rewrite what those days looked like. Instead you write a
 * NEW version starting today or later, and the old one keeps its rows and
 * closes the day before. The editor makes that the path of least resistance
 * rather than a rule to be explained: opening a version that is already in
 * force pre-fills the start date with today, and the button says "Save from".
 */
export function HoursManager({
  staff,
  timeZone,
  today,
}: {
  staff: StaffHours[];
  timeZone: string;
  /** The business's LOCAL date, resolved on the server. Never the browser's. */
  today: string;
}) {
  const [staffId, setStaffId] = useState(() => staff[0]?.staffId ?? "");
  const member = staff.find((candidate) => candidate.staffId === staffId);

  if (staff.length === 0) {
    return (
      <div className="flex flex-col gap-8">
        <HoursHeader timeZone={timeZone} />
        <EmptyState
          icon={Users}
          title="Nobody to give hours to"
          description="Hours belong to a person, not to the business — that is what lets two people work different days. Add someone on the Staff page first."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <HoursHeader timeZone={timeZone} />

      <Field
        id="hours-staff"
        label="Whose hours"
        hint="Each person keeps their own weekly pattern. The agenda draws one column per person."
      >
        {(props) => (
          <SelectNative
            {...props}
            value={staffId}
            onChange={(event) => setStaffId(event.target.value)}
            className="max-w-sm"
          >
            {staff.map((candidate) => (
              <option key={candidate.staffId} value={candidate.staffId}>
                {candidate.name}
                {candidate.isActive ? "" : " (not offered)"}
              </option>
            ))}
          </SelectNative>
        )}
      </Field>

      {member ? (
        <StaffHoursPanel
          // Remounts when the person changes, so the editor is seeded from the
          // new person's data rather than carrying the previous one's edits.
          key={member.staffId}
          member={member}
          otherStaff={staff.filter(
            (candidate) => candidate.staffId !== member.staffId,
          )}
          timeZone={timeZone}
          today={today}
        />
      ) : null}
    </div>
  );
}

function HoursHeader({ timeZone }: { timeZone: string }) {
  return (
    <PageHeader
      eyebrow="Hours"
      title="Opening hours"
      description={`Recurring weekly hours, written and stored as local wall-clock times in ${timeZone.replace(
        /_/g,
        " ",
      )}. Nine o'clock stays nine o'clock through a daylight-saving change, because the rule is a time on a clock rather than a moment in time.`}
    />
  );
}

function emptyWeek(): EditorDay[] {
  return Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    intervals: [],
  }));
}

function StaffHoursPanel({
  member,
  otherStaff,
  timeZone,
  today,
}: {
  member: StaffHours;
  otherStaff: StaffHours[];
  timeZone: string;
  today: string;
}) {
  const current =
    member.versions.find((version) => version.isCurrent) ??
    member.versions[member.versions.length - 1] ??
    null;

  const [selectedFrom, setSelectedFrom] = useState<string | null>(
    current?.effectiveFrom ?? null,
  );

  const selected =
    member.versions.find(
      (version) => version.effectiveFrom === selectedFrom,
    ) ?? null;

  /**
   * The date the version being edited will start.
   *
   * A version already in force cannot be rewritten, so editing one starts a
   * NEW version from today. A future version is edited in place and keeps its
   * own date.
   */
  const [effectiveFrom, setEffectiveFrom] = useState<string>(() =>
    selected && selected.effectiveFrom > today ? selected.effectiveFrom : today,
  );

  const [days, setDays] = useState<EditorDay[]>(() =>
    selected ? cloneDays(selected) : emptyWeek(),
  );

  const [dayErrors, setDayErrors] = useState<Record<number, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyTargets, setCopyTargets] = useState<string[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState<HoursVersion | null>(
    null,
  );

  /** Flattened for the preview and for nothing else. */
  const intervals: LocalInterval[] = useMemo(
    () =>
      days.flatMap((day) =>
        day.intervals.map((interval) => ({
          weekday: day.weekday,
          startLocal: interval.startLocal,
          endLocal: interval.endLocal,
        })),
      ),
    [days],
  );

  const editingExisting = selected?.effectiveFrom === effectiveFrom;
  const startsInFuture = effectiveFrom > today;

  function loadVersion(version: HoursVersion): void {
    setSelectedFrom(version.effectiveFrom);
    setDays(cloneDays(version));
    setEffectiveFrom(
      version.effectiveFrom > today ? version.effectiveFrom : today,
    );
    setDayErrors({});
    setFormError(null);
  }

  function startNewVersion(): void {
    setSelectedFrom(null);
    // Seeded from what is in force, because a change of hours is almost always
    // a change to the hours, not a blank slate.
    setDays(current ? cloneDays(current) : emptyWeek());
    setEffectiveFrom(today);
    setDayErrors({});
    setFormError(null);
  }

  function submit(): void {
    /**
     * Parsed here with the SAME schema the action parses, so the overlap
     * message beside the row is the message the server would have sent. The
     * server still parses it again — this is a courtesy, not the boundary.
     */
    const parsed = weeklyHoursSchema.safeParse({
      staffId: member.staffId,
      effectiveFrom,
      days,
    });

    if (!parsed.success) {
      const collected: Record<number, string> = {};

      for (const issue of parsed.error.issues) {
        if (issue.path[0] === "days" && typeof issue.path[1] === "number") {
          collected[issue.path[1]] ??= issue.message;
        }
      }

      setDayErrors(collected);
      setFormError(parsed.error.issues[0]?.message ?? "Check the week.");
      return;
    }

    startSaving(async () => {
      const result = await saveWeeklyHours({
        staffId: member.staffId,
        effectiveFrom,
        days,
      });

      if (!result.ok) {
        setDayErrors(result.dayErrors ?? {});
        setFormError(result.message);
        toast.error(result.message);
        return;
      }

      setDayErrors({});
      setFormError(null);
      setSelectedFrom(effectiveFrom);
      toast.success(result.message);
    });
  }

  function submitCopy(): void {
    startSaving(async () => {
      const result = await copyWeekToStaff(
        { staffId: member.staffId, effectiveFrom, days },
        copyTargets,
      );

      if (!result.ok) {
        toast.error(result.message);
        return;
      }

      toast.success(result.message);
      setCopyOpen(false);
      setCopyTargets([]);
    });
  }

  function removeVersion(version: HoursVersion): void {
    setConfirmingDelete(null);

    startSaving(async () => {
      const result = await deleteHoursVersion(
        member.staffId,
        version.effectiveFrom,
      );

      if (result.ok) {
        toast.success(result.message);
        if (selectedFrom === version.effectiveFrom) {
          setSelectedFrom(current?.effectiveFrom ?? null);
        }
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <div className="flex flex-col gap-8">
      {/* The timeline of versions. Reads as history, which is what it is. */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="type-section text-ink">
            {member.name}&rsquo;s hours over time
          </h2>

          <PillButton variant="secondary" size="sm" onClick={startNewVersion}>
            <Plus aria-hidden="true" />
            New hours from a date
          </PillButton>
        </div>

        {member.versions.length === 0 ? (
          <p className="type-body-sm rounded-card border border-dashed border-line px-4 py-3 text-ink-muted">
            No hours yet. Set a week below and {member.name} becomes bookable.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {member.versions.map((version) => (
              <li key={version.effectiveFrom}>
                <button
                  type="button"
                  onClick={() => loadVersion(version)}
                  aria-pressed={selectedFrom === version.effectiveFrom}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-card border px-4 py-3 text-left transition-colors",
                    selectedFrom === version.effectiveFrom
                      ? "border-accent bg-accent-wash"
                      : "border-line bg-surface hover:bg-surface-sunk",
                  )}
                >
                  <span className="type-time text-ink">
                    {version.effectiveFrom}
                    {version.effectiveTo ? ` – ${version.effectiveTo}` : " →"}
                  </span>

                  <span className="flex flex-wrap items-center gap-2">
                    {version.isCurrent ? (
                      <StatusBadge tone="confirmed">In force</StatusBadge>
                    ) : version.isFuture ? (
                      <StatusBadge tone="pending">Scheduled</StatusBadge>
                    ) : (
                      <StatusBadge tone="neutral">Past</StatusBadge>
                    )}

                    <span className="type-body-sm text-ink-muted">
                      {version.weeklyMinutes === 0
                        ? "Closed all week"
                        : `${formatDuration(version.weeklyMinutes)} a week`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <h2 className="type-section text-ink">
            {editingExisting && startsInFuture
              ? `Editing the hours starting ${effectiveFrom}`
              : "New hours"}
          </h2>

          {/* The rule, stated where the decision is made. */}
          <p className="type-body-sm text-ink-muted">
            {startsInFuture
              ? `These take effect on ${effectiveFrom}. Everything before that keeps the hours it already had.`
              : "These take effect today. Days that have already happened keep the hours they were booked under — set a later date to change hours from a future day instead."}
          </p>
        </div>

        {formError ? <FormError>{formError}</FormError> : null}

        <Field
          id="hours-effective-from"
          label="In effect from"
          hint="A local date in the business timezone. Today or later — past hours are history and stay as they are."
        >
          {(props) => (
            <Input
              {...props}
              type="date"
              min={today}
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
              className="type-time max-w-[12rem]"
            />
          )}
        </Field>

        <WeekEditor
          days={days}
          dayErrors={dayErrors}
          onChange={setDays}
          disabled={saving}
        />

        <div className="flex flex-wrap gap-3">
          <PillButton onClick={submit} disabled={saving}>
            {saving
              ? "Saving…"
              : startsInFuture
                ? `Save from ${effectiveFrom}`
                : "Save from today"}
          </PillButton>

          {otherStaff.length > 0 ? (
            <PillButton
              variant="secondary"
              onClick={() => setCopyOpen((open) => !open)}
              disabled={saving}
            >
              <Users aria-hidden="true" />
              Copy this week to others
            </PillButton>
          ) : null}

          {selected?.isFuture ? (
            <PillButton
              variant="quiet"
              onClick={() => setConfirmingDelete(selected)}
              disabled={saving}
            >
              <Trash2 aria-hidden="true" />
              Discard these scheduled hours
            </PillButton>
          ) : null}
        </div>

        {copyOpen ? (
          <div className="flex flex-col gap-3 rounded-card border border-line bg-surface-sunk/60 p-4">
            <Field
              id="hours-copy-targets"
              label="Copy to"
              hint={`Writes the same week for each person, in effect from ${effectiveFrom}. Their other dated hours are left alone.`}
            >
              {(props) => (
                <AssignmentPicker
                  id={props.id}
                  label="Copy these hours to"
                  options={otherStaff.map((candidate) => ({
                    id: candidate.staffId,
                    label: candidate.name,
                    meta: candidate.initials,
                    isInactive: !candidate.isActive,
                  }))}
                  selectedIds={copyTargets}
                  onChange={setCopyTargets}
                  emptyMessage="Nobody else to copy to."
                  describedBy={props["aria-describedby"]}
                />
              )}
            </Field>

            <div className="flex flex-wrap gap-3">
              <PillButton
                size="sm"
                onClick={submitCopy}
                disabled={saving || copyTargets.length === 0}
              >
                Copy the week
              </PillButton>
              <PillButton
                variant="secondary"
                size="sm"
                onClick={() => setCopyOpen(false)}
                disabled={saving}
              >
                Cancel
              </PillButton>
            </div>
          </div>
        ) : null}
      </section>

      <WeekPreview
        intervals={intervals}
        timeZone={timeZone}
        title="What this week looks like"
      />

      <ConfirmDialog
        open={confirmingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmingDelete(null);
          }
        }}
        title="Discard these scheduled hours?"
        description={
          confirmingDelete
            ? `The hours due to start on ${confirmingDelete.effectiveFrom} are removed, and whatever is in force now carries on. Nothing already booked changes.`
            : ""
        }
        confirmLabel="Discard"
        cancelLabel="Keep them"
        destructive
        onConfirm={() => {
          if (confirmingDelete) {
            removeVersion(confirmingDelete);
          }
        }}
      />

      <p className="type-body-sm flex items-start gap-3 rounded-card border border-line bg-surface-sunk/60 px-4 py-3 text-ink-muted">
        <CalendarClock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>
          Hours say when someone is available. Holidays and one-off closures are
          subtracted on top of them — set those on the Time off page.
        </span>
      </p>
    </div>
  );
}

/** Deep enough that editing the form never mutates the loaded version. */
function cloneDays(version: HoursVersion): EditorDay[] {
  return version.days.map((day) => ({
    weekday: day.weekday,
    intervals: day.intervals.map((interval) => ({ ...interval })),
  }));
}
