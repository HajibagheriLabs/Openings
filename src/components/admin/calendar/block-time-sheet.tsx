"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/field";
import { PillButton } from "@/components/pill-button";
import { Sheet } from "@/components/sheet";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import type { CalendarStaffOption } from "@/lib/admin/calendar";
import { blockTime, unblockTime } from "@/server/actions/agenda";

/**
 * Blocking a stretch of the day out.
 *
 * ═══ THE FORM IS THE FALLBACK, THE DRAG IS THE GESTURE ═══
 *
 * The primary way to block time is to drag on an empty part of the ribbon —
 * see ./calendar-workspace.tsx and the range layer in the Ribbon. That gesture
 * opens this sheet already filled in, so the fields below are usually a
 * confirmation of what the pointer said rather than something to type. They are
 * still here because a drag is impossible on a keyboard and awkward on a small
 * phone, and blocking out an afternoon must not require a mouse.
 *
 * ═══ INSTANT, AND UNDOABLE ═══
 *
 * Unlike the time-off screen, which holds a closure back for review when it
 * would sit on live appointments, this writes immediately. A two-second gesture
 * interrupted by a confirmation dialog is not a two-second gesture — so instead
 * the toast SAYS what it landed on and offers an undo that really deletes the
 * row. Blocking never cancels the appointments underneath it; it only stops new
 * bookings landing there.
 */
export function BlockTimeSheet({
  open,
  onOpenChange,
  staff,
  defaultDate,
  defaultStartLocal,
  defaultEndLocal,
  defaultStaffId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  staff: CalendarStaffOption[];
  defaultDate: string;
  defaultStartLocal: string;
  defaultEndLocal: string;
  /** Null means the whole business — the same meaning as `time_off.staff_id`. */
  defaultStaffId: string | null;
}) {
  const [staffId, setStaffId] = useState(defaultStaffId ?? "");
  const [date, setDate] = useState(defaultDate);
  const [startLocal, setStartLocal] = useState(defaultStartLocal);
  const [endLocal, setEndLocal] = useState(defaultEndLocal);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(): void {
    setError(null);

    startTransition(async () => {
      const result = await blockTime({
        staffId: staffId || null,
        date,
        startLocal,
        endLocal,
        reason,
      });

      if (!result.ok) {
        setError(result.message);
        return;
      }

      onOpenChange(false);

      toast.success(result.message, {
        action: {
          label: "Undo",
          onClick: () => {
            void unblockTime(result.timeOffId).then((undone) => {
              if (undone.ok) {
                toast.success(undone.message);
              } else {
                toast.error(undone.message);
              }
            });
          },
        },
      });
    });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side="right"
      title="Block out time"
      description="Stops new bookings landing here. Appointments already in it stay put."
      footer={
        <div className="flex justify-end gap-3">
          <PillButton
            variant="secondary"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </PillButton>
          <PillButton size="sm" onClick={submit} disabled={pending}>
            {pending ? "Blocking…" : "Block it"}
          </PillButton>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {error ? <FormError>{error}</FormError> : null}

        <Field
          id="block-staff"
          label="Who it applies to"
          hint="Blocking the whole business closes it for everybody, including anyone you add later."
        >
          {(props) => (
            <SelectNative
              {...props}
              value={staffId}
              onChange={(event) => setStaffId(event.target.value)}
            >
              <option value="">The whole business</option>
              {staff.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </SelectNative>
          )}
        </Field>

        <Field id="block-date" label="Date">
          {(props) => (
            <Input
              {...props}
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          )}
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field id="block-start" label="From">
            {(props) => (
              <Input
                {...props}
                type="time"
                value={startLocal}
                onChange={(event) => setStartLocal(event.target.value)}
              />
            )}
          </Field>

          <Field id="block-end" label="Until">
            {(props) => (
              <Input
                {...props}
                type="time"
                value={endLocal}
                onChange={(event) => setEndLocal(event.target.value)}
              />
            )}
          </Field>
        </div>

        <Field
          id="block-reason"
          label="Reason"
          optional
          hint="Shown on your calendar, never to a customer."
        >
          {(props) => (
            <Input
              {...props}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Dentist, stock delivery, lunch"
            />
          )}
        </Field>

        <p className="type-body-sm text-ink-muted">
          For a whole day off, or several days, use the Time off screen — it
          handles local day boundaries and daylight saving properly. This one is
          for a stretch of a single day.
        </p>
      </div>
    </Sheet>
  );
}
