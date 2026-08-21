"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { AssignmentPicker } from "@/components/assignment-picker";
import { Field, FormError } from "@/components/field";
import { PillButton } from "@/components/pill-button";
import { Sheet } from "@/components/sheet";
import { ToggleField } from "@/components/toggle-switch";
import { Input } from "@/components/ui/input";
import { formatDuration } from "@/components/time-text";
import { initialsFrom } from "@/lib/initials";
import {
  INITIALS_MAX_LENGTH,
  staffFormSchema,
} from "@/lib/validation/catalog";
import { saveStaff, type StaffField } from "@/server/actions/staff";
import type { ServiceRow, StaffRow } from "@/server/queries/catalog";

/**
 * Create or edit one staff member.
 *
 * The initials field is the interesting one. It is derived from the name as
 * the name is typed, and it stops deriving the moment the owner touches it —
 * exactly the same rule the onboarding wizard applies to the business address,
 * and for the same reason: fixing a collision by hand must not be undone by a
 * later typo fix in the field it was derived from. Two colleagues really do
 * collapse to "AA", and only the owner knows whether the answer is "AAn" or
 * "AAh".
 */

export interface StaffFormValue {
  name: string;
  email: string;
  initials: string;
  serviceIds: string[];
  isActive: boolean;
  /** Once true, the name stops rewriting the initials. */
  initialsEdited: boolean;
}

type StaffFieldErrors = Partial<Record<StaffField, string>>;

function blankStaff(): StaffFormValue {
  return {
    name: "",
    email: "",
    initials: "",
    serviceIds: [],
    isActive: true,
    initialsEdited: false,
  };
}

function toFormValue(member: StaffRow): StaffFormValue {
  return {
    name: member.name,
    email: member.email ?? "",
    initials: member.initials,
    serviceIds: member.services.map((service) => service.id),
    isActive: member.isActive,
    // An existing member's initials are already a decision, whoever made it.
    initialsEdited: true,
  };
}

export function StaffSheet({
  open,
  onOpenChange,
  member,
  serviceOptions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null creates; a row edits. */
  member: StaffRow | null;
  serviceOptions: ServiceRow[];
}) {
  /** Seeded on mount; the parent keys this component. See ServiceSheet. */
  const [value, setValue] = useState<StaffFormValue>(() =>
    member ? toFormValue(member) : blankStaff(),
  );
  const [errors, setErrors] = useState<StaffFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  function patch(next: Partial<StaffFormValue>): void {
    setValue((current) => ({ ...current, ...next }));
  }

  function handleNameChange(name: string): void {
    setValue((current) => ({
      ...current,
      name,
      initials: current.initialsEdited
        ? current.initials
        : name.trim()
          ? initialsFrom(name)
          : "",
    }));
  }

  function submit(): void {
    const parsed = staffFormSchema.safeParse({
      id: member?.id,
      name: value.name,
      email: value.email,
      initials: value.initials,
      serviceIds: value.serviceIds,
      isActive: value.isActive,
    });

    if (!parsed.success) {
      const collected: StaffFieldErrors = {};

      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string") {
          collected[key as StaffField] ??= issue.message;
        }
      }

      setErrors(collected);
      setFormError(parsed.error.issues[0]?.message ?? "Check the form.");
      return;
    }

    startSaving(async () => {
      const result = await saveStaff({
        id: member?.id,
        name: value.name,
        email: value.email,
        initials: value.initials,
        serviceIds: value.serviceIds,
        isActive: value.isActive,
      });

      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        setFormError(result.message);
        toast.error(result.message);
        return;
      }

      toast.success(result.message);
      onOpenChange(false);
    });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side="right"
      title={member ? member.name : "New staff member"}
      description={
        member
          ? "Their appointments stay with them, whatever you change here."
          : "Someone who takes bookings. They get a column in the agenda, not an account."
      }
      className="w-[min(34rem,94vw)]"
      footer={
        <div className="flex flex-wrap justify-end gap-3">
          <PillButton
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </PillButton>
          <PillButton onClick={submit} disabled={saving}>
            {saving ? "Saving…" : member ? "Save staff member" : "Add staff member"}
          </PillButton>
        </div>
      }
    >
      <div className="flex flex-col gap-6">
        {formError ? <FormError>{formError}</FormError> : null}

        <Field id="staff-name" label="Name" error={errors.name}>
          {(props) => (
            <Input
              {...props}
              value={value.name}
              onChange={(event) => handleNameChange(event.target.value)}
              placeholder="Rosa Delgado"
            />
          )}
        </Field>

        <Field
          id="staff-initials"
          label="Initials"
          hint="Drawn on their booked blocks in the agenda, where colour carries no meaning. Filled in from the name — change it if two people would otherwise look the same."
          error={errors.initials}
        >
          {(props) => (
            <div className="flex items-center gap-3">
              <Input
                {...props}
                value={value.initials}
                maxLength={INITIALS_MAX_LENGTH}
                onChange={(event) =>
                  patch({
                    initials: event.target.value.toUpperCase(),
                    initialsEdited: true,
                  })
                }
                placeholder="RD"
                className="type-time max-w-[6rem] text-center"
              />

              {/* How it will actually read on a carved-out segment: sunk
                  surface, inset, muted ink — the booked state, not a swatch. */}
              <span
                aria-hidden="true"
                className="type-time inline-flex h-11 w-16 items-center justify-center rounded-segment bg-surface-sunk text-ink-muted shadow-inset"
              >
                {value.initials || "—"}
              </span>
            </div>
          )}
        </Field>

        <Field
          id="staff-email"
          label="Email"
          optional
          hint="For your own records. Staff do not sign in — only you have an account."
          error={errors.email}
        >
          {(props) => (
            <Input
              {...props}
              type="email"
              inputMode="email"
              value={value.email}
              onChange={(event) => patch({ email: event.target.value })}
              placeholder="rosa@example.com"
            />
          )}
        </Field>

        <Field
          id="staff-services"
          label="Services they perform"
          hint="The same assignment the service form edits, seen from this side."
          error={errors.serviceIds}
        >
          {(props) => (
            <AssignmentPicker
              id={props.id}
              label="Services they perform"
              options={serviceOptions.map((service) => ({
                id: service.id,
                label: service.name,
                meta: formatDuration(service.durationMin),
                isInactive: !service.isActive,
              }))}
              selectedIds={value.serviceIds}
              onChange={(serviceIds) => patch({ serviceIds })}
              emptyMessage="No services yet. Add one on the Services page first."
              describedBy={props["aria-describedby"]}
            />
          )}
        </Field>

        <ToggleField
          id="staff-active"
          label="Takes bookings"
          description={
            value.isActive
              ? "Offered to customers, and expanded into available time."
              : "Removed from future availability only. Every appointment they already have stays in the calendar, theirs, unchanged."
          }
          checked={value.isActive}
          onCheckedChange={(isActive) => patch({ isActive })}
        />

        {member && !value.isActive && member.futureAppointmentCount > 0 ? (
          <p className="type-body-sm rounded-card border border-pending/40 bg-pending/10 px-4 py-3 text-pending">
            {member.name} has {member.futureAppointmentCount} appointment
            {member.futureAppointmentCount === 1 ? "" : "s"} still to come. Those
            stay exactly where they are — switching off only stops new bookings.
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
