"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/field";
import { PillButton } from "@/components/pill-button";
import { Ribbon } from "@/components/ribbon";
import { Sheet } from "@/components/sheet";
import { ToggleField } from "@/components/toggle-switch";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { Textarea } from "@/components/ui/textarea";
import {
  createTimeOff,
  previewTimeOffWeek,
  type TimeOffPreview,
} from "@/server/actions/time-off";
import type { ConflictingAppointment } from "@/server/queries/hours";

import { ConflictList } from "./conflict-list";

/**
 * Blocking out a range.
 *
 * TWO THINGS HERE ARE SERVER WORK, AND BOTH ARE DONE ON THE SERVER.
 *
 * 1. RESOLVING THE RANGE. "All day on 25 December" is a local day, and where
 *    that day starts and ends depends on the business's timezone and on
 *    whether DST moved that week. The form sends local dates and times; the
 *    action turns them into instants. Nothing here does date arithmetic.
 *
 * 2. THE PREVIEW. What the week will look like — where the closure lands,
 *    which open hours it eats — is the same arithmetic, so the preview is a
 *    Server Action too, debounced as the form changes. That is the opposite
 *    choice from the weekly-hours preview, which draws a pattern of
 *    wall-clock minutes and needs no server at all. The difference is exactly
 *    the difference between a pattern and a moment.
 */

export interface TimeOffStaffOption {
  id: string;
  name: string;
  isActive: boolean;
}

interface FormValue {
  staffId: string;
  startDate: string;
  endDate: string;
  isAllDay: boolean;
  startLocal: string;
  endLocal: string;
  reason: string;
}

/** The sentinel for the nullable column. "" would be indistinguishable. */
const WHOLE_BUSINESS = "business";

export function TimeOffSheet({
  open,
  onOpenChange,
  staff,
  timeZone,
  today,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  staff: TimeOffStaffOption[];
  timeZone: string;
  /** The business's local date, from the server. */
  today: string;
}) {
  const [value, setValue] = useState<FormValue>(() => ({
    staffId: WHOLE_BUSINESS,
    startDate: today,
    endDate: today,
    isAllDay: true,
    startLocal: "09:00",
    endLocal: "17:00",
    reason: "",
  }));

  const [formError, setFormError] = useState<string | null>(null);
  const [field, setField] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ConflictingAppointment[] | null>(
    null,
  );
  const [preview, setPreview] = useState<TimeOffPreview | null>(null);
  const [saving, startSaving] = useTransition();

  function patch(next: Partial<FormValue>): void {
    setValue((current) => ({ ...current, ...next }));
    // Any edit invalidates a review the owner has already read: the range they
    // acknowledged is not the range they now have.
    setConflicts(null);
  }

  /**
   * The form's own shape to the action's. Pure, and takes the value rather
   * than closing over it, so the preview effect below can depend on the value
   * object itself instead of listing seven fields and hoping.
   */
  function toInput(form: FormValue, acknowledge: boolean) {
    return {
      staffId: form.staffId === WHOLE_BUSINESS ? null : form.staffId,
      startDate: form.startDate,
      endDate: form.endDate,
      isAllDay: form.isAllDay,
      startLocal: form.isAllDay ? undefined : form.startLocal,
      endLocal: form.isAllDay ? undefined : form.endLocal,
      reason: form.reason,
      acknowledgeConflicts: acknowledge,
    };
  }

  /**
   * Ask the server to redraw the week.
   *
   * Debounced because it is a round trip on every keystroke otherwise, and
   * guarded by a request id because the answers can come back out of order —
   * a stale preview showing the previous date would be worse than none.
   */
  const requestId = useRef(0);

  useEffect(() => {
    if (!open) {
      return;
    }

    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      const result = await previewTimeOffWeek(toInput(value, false));

      // Answers can arrive out of order; only the newest one may paint. A
      // stale preview showing the previous date would be worse than none.
      if (requestId.current === id) {
        setPreview(result);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [open, value]);

  function submit(acknowledge: boolean): void {
    startSaving(async () => {
      const result = await createTimeOff(toInput(value, acknowledge));

      if (!result.ok) {
        setFormError(result.message);
        setField(result.field ?? null);

        if (result.conflicts) {
          // Held back for review, not rejected. The list appears and the
          // primary button becomes "Block it anyway".
          setConflicts(result.conflicts);
        } else {
          toast.error(result.message);
        }

        return;
      }

      toast.success(result.message);
      onOpenChange(false);
    });
  }

  const awaitingAcknowledgement = conflicts !== null && conflicts.length > 0;

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side="right"
      title="Block out time"
      description="A holiday, a closure, an afternoon off. Blocked time is subtracted from availability; it never cancels anything."
      className="w-[min(36rem,94vw)]"
      footer={
        <div className="flex flex-wrap justify-end gap-3">
          <PillButton
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </PillButton>

          <PillButton
            onClick={() => submit(awaitingAcknowledgement)}
            disabled={saving}
          >
            {saving
              ? "Saving…"
              : awaitingAcknowledgement
                ? "Block it anyway"
                : "Block this time"}
          </PillButton>
        </div>
      }
    >
      <div className="flex flex-col gap-6">
        {formError && !awaitingAcknowledgement ? (
          <FormError>{formError}</FormError>
        ) : null}

        <Field
          id="time-off-staff"
          label="Who is off"
          hint="A whole-business closure applies to everyone, including anyone hired later."
        >
          {(props) => (
            <SelectNative
              {...props}
              value={value.staffId}
              onChange={(event) => patch({ staffId: event.target.value })}
            >
              <option value={WHOLE_BUSINESS}>The whole business</option>
              {staff.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                  {member.isActive ? "" : " (not offered)"}
                </option>
              ))}
            </SelectNative>
          )}
        </Field>

        <ToggleField
          id="time-off-all-day"
          label="All day"
          description={
            value.isAllDay
              ? `Covers whole local days in ${timeZone.replace(/_/g, " ")} — from local midnight to local midnight, not from 00:00 UTC.`
              : "Give the exact local times the block starts and ends."
          }
          checked={value.isAllDay}
          onCheckedChange={(isAllDay) => patch({ isAllDay })}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="time-off-start-date"
            label="First day"
            error={field === "startDate" ? formError ?? undefined : undefined}
          >
            {(props) => (
              <Input
                {...props}
                type="date"
                value={value.startDate}
                onChange={(event) => {
                  const startDate = event.target.value;
                  patch({
                    startDate,
                    // Dragging the start past the end is a slip, not a request
                    // for an empty range.
                    endDate:
                      value.endDate < startDate ? startDate : value.endDate,
                  });
                }}
                className="type-time"
              />
            )}
          </Field>

          <Field
            id="time-off-end-date"
            label="Last day"
            hint="Inclusive — the block covers this day too."
            error={field === "endDate" ? formError ?? undefined : undefined}
          >
            {(props) => (
              <Input
                {...props}
                type="date"
                min={value.startDate}
                value={value.endDate}
                onChange={(event) => patch({ endDate: event.target.value })}
                className="type-time"
              />
            )}
          </Field>
        </div>

        {!value.isAllDay ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="time-off-start-time"
              label="Starts at"
              error={field === "startLocal" ? formError ?? undefined : undefined}
            >
              {(props) => (
                <Input
                  {...props}
                  type="time"
                  value={value.startLocal}
                  onChange={(event) =>
                    patch({ startLocal: event.target.value })
                  }
                  className="type-time"
                />
              )}
            </Field>

            <Field
              id="time-off-end-time"
              label="Ends at"
              error={field === "endLocal" ? formError ?? undefined : undefined}
            >
              {(props) => (
                <Input
                  {...props}
                  type="time"
                  value={value.endLocal}
                  onChange={(event) => patch({ endLocal: event.target.value })}
                  className="type-time"
                />
              )}
            </Field>
          </div>
        ) : null}

        <Field
          id="time-off-reason"
          label="Reason"
          optional
          hint="For your own records. Customers never see it — they only see that the time is unavailable."
        >
          {(props) => (
            <Textarea
              {...props}
              rows={2}
              value={value.reason}
              onChange={(event) => patch({ reason: event.target.value })}
              placeholder="Public holiday"
            />
          )}
        </Field>

        {conflicts ? (
          <ConflictList conflicts={conflicts} timeZone={timeZone} />
        ) : null}

        {preview ? (
          <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h3 className="type-section text-ink">That week</h3>
              <p className="type-body-sm text-ink-muted">
                Open time in the accent, blocked time hatched. Resolved on the
                server in {timeZone.replace(/_/g, " ")}, so an all-day block
                lands on real local midnights.
              </p>
            </div>

            <Ribbon
              window={preview.window}
              columns={preview.columns}
              timeZone={timeZone}
              ariaLabel="Preview of the week this block falls in"
            />
          </section>
        ) : null}
      </div>
    </Sheet>
  );
}
