"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Card, CardBody, CardHeader } from "@/components/card";
import { Field } from "@/components/field";
import { PillButton } from "@/components/pill-button";
import { SelectNative } from "@/components/ui/select-native";
import { REMINDER_LEAD_OPTIONS } from "@/lib/validation/notifications";
import { updateReminderSettings } from "@/server/actions/notifications";

/**
 * When the reminder goes out.
 *
 * A LIST OF TIMES, NOT A NUMBER FIELD. "How long before?" has about ten
 * sensible answers, and a text box invites all the others — a day typed as
 * "24" into a field that means minutes, or 1440 typed as 144. The list is
 * validation nobody has to read.
 *
 * The two sentences under it are the whole behaviour of the feature, and they
 * are on the page rather than in a tooltip: a change applies to new bookings,
 * and a booking made inside the window gets no reminder at all. Both are
 * things an owner would otherwise discover by wondering why a customer was
 * never reminded.
 */
export function ReminderSettings({
  reminderLeadMin,
}: {
  reminderLeadMin: number;
}) {
  const [value, setValue] = useState(String(reminderLeadMin));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const saved = String(reminderLeadMin);

  function save() {
    setError(null);

    startTransition(async () => {
      const result = await updateReminderSettings({
        reminderLeadMin: Number(value),
      });

      if (result.ok) {
        toast.success(result.message);
        return;
      }

      setError(result.fieldErrors?.reminderLeadMin ?? result.message);
      toast.error(result.message);
    });
  }

  return (
    <Card>
      <CardHeader
        title="Reminders"
        description="A short email the day of, or the day before — whatever suits how people book with you."
      />

      <CardBody className="flex flex-col gap-5">
        <Field
          id="reminder-lead"
          label="Send the reminder"
          error={error}
          hint="Applies to bookings made from now on. Anything already booked keeps the timing it was booked with."
        >
          {(control) => (
            <SelectNative
              {...control}
              value={value}
              disabled={pending}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
            >
              {REMINDER_LEAD_OPTIONS.map((option) => (
                <option key={option.minutes} value={option.minutes}>
                  {option.label}
                </option>
              ))}
            </SelectNative>
          )}
        </Field>

        <p className="type-body-sm text-ink-faint">
          Somebody booking inside that window gets no reminder — the appointment
          is sooner than the reminder would be, and a second email a minute
          after the confirmation reads as a duplicate.
        </p>

        <div>
          <PillButton
            type="button"
            onClick={save}
            disabled={pending || value === saved}
          >
            {pending ? "Saving" : "Save"}
          </PillButton>
        </div>
      </CardBody>
    </Card>
  );
}
