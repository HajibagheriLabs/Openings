"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { AssignmentPicker } from "@/components/assignment-picker";
import { Field, FormError } from "@/components/field";
import { PillButton } from "@/components/pill-button";
import { Sheet } from "@/components/sheet";
import { ToggleField } from "@/components/toggle-switch";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { Textarea } from "@/components/ui/textarea";
import { BlockedTimePreview } from "@/components/admin/blocked-time-preview";
import { centsToInput } from "@/lib/money";
import {
  buildServiceFormSchema,
  SERVICE_MAX_BUFFER_MIN,
  SERVICE_MAX_DURATION_MIN,
} from "@/lib/validation/catalog";
import type { ServiceRow, StaffSummary } from "@/server/queries/catalog";
import { saveService, type ServiceField } from "@/server/actions/services";

/**
 * Create or edit one service.
 *
 * The form validates with the SAME schema the Server Action parses, built from
 * the same slot granularity, so the message beside the duration field is the
 * message the server would have sent. Two boundaries, one contract — and the
 * server still parses again, because this is a public HTTP endpoint and
 * whatever the browser did is a suggestion.
 */

export interface ServiceFormValue {
  name: string;
  description: string;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  price: string;
  depositType: "none" | "flat" | "percent";
  deposit: string;
  staffIds: string[];
  isActive: boolean;
}

type ServiceFieldErrors = Partial<Record<ServiceField, string>>;

/** What a brand new service starts as. */
function blankService(): ServiceFormValue {
  return {
    name: "",
    description: "",
    durationMin: 60,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    price: "",
    depositType: "none",
    deposit: "0",
    staffIds: [],
    isActive: true,
  };
}

function toFormValue(service: ServiceRow): ServiceFormValue {
  return {
    name: service.name,
    description: service.description ?? "",
    durationMin: service.durationMin,
    bufferBeforeMin: service.bufferBeforeMin,
    bufferAfterMin: service.bufferAfterMin,
    price: centsToInput(service.priceCents),
    depositType: service.depositType,
    deposit:
      service.depositType === "flat"
        ? centsToInput(service.depositValue)
        : service.depositType === "percent"
          ? String(service.depositValue)
          : "0",
    staffIds: service.staff.map((member) => member.id),
    isActive: service.isActive,
  };
}

/**
 * Length presets, generated from the business's own grid rather than hardcoded.
 *
 * A shop on a 20-minute granularity should never be offered a 45-minute chip
 * that the form will then refuse. The presets are always legal by
 * construction.
 */
function durationPresets(granularity: number): number[] {
  const wanted = [15, 30, 45, 60, 90, 120];
  const snapped = new Set<number>();

  for (const minutes of wanted) {
    const rounded = Math.round(minutes / granularity) * granularity;
    if (rounded > 0 && rounded <= SERVICE_MAX_DURATION_MIN) {
      snapped.add(rounded);
    }
  }

  return [...snapped].sort((a, b) => a - b);
}

export function ServiceSheet({
  open,
  onOpenChange,
  service,
  staffOptions,
  currency,
  slotGranularityMin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null creates; a row edits. */
  service: ServiceRow | null;
  staffOptions: StaffSummary[];
  currency: string;
  slotGranularityMin: number;
}) {
  /**
   * THE FORM IS SEEDED ON MOUNT, AND THE PARENT KEYS THIS COMPONENT ON WHICH
   * SERVICE IS OPEN.
   *
   * The obvious alternative — an effect that copies `service` into state
   * whenever the sheet opens — is the pattern React explicitly warns about: it
   * renders once with the wrong values, then sets state, then renders again,
   * and the owner can see the previous service's name for a frame. A changed
   * key makes this a NEW form instance whose state starts correct, which is
   * both faster and impossible to get subtly wrong.
   */
  const [value, setValue] = useState<ServiceFormValue>(() =>
    service ? toFormValue(service) : blankService(),
  );
  const [errors, setErrors] = useState<ServiceFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const presets = durationPresets(slotGranularityMin);
  const offGrid =
    value.durationMin > 0 && value.durationMin % slotGranularityMin !== 0;

  function patch(next: Partial<ServiceFormValue>): void {
    setValue((current) => ({ ...current, ...next }));
  }

  function submit(): void {
    const parsed = buildServiceFormSchema(slotGranularityMin).safeParse({
      ...value,
      id: service?.id,
    });

    if (!parsed.success) {
      const collected: ServiceFieldErrors = {};

      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string") {
          collected[key as ServiceField] ??= issue.message;
        }
      }

      setErrors(collected);
      setFormError(parsed.error.issues[0]?.message ?? "Check the form.");
      return;
    }

    startSaving(async () => {
      const result = await saveService({ ...value, id: service?.id });

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
      title={service ? service.name : "New service"}
      description={
        service
          ? "Changes apply to new bookings. Appointments already made keep the price and length they were booked at."
          : "What customers can book, how long it takes, and what it costs."
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
            {saving ? "Saving…" : service ? "Save service" : "Add service"}
          </PillButton>
        </div>
      }
    >
      <div className="flex flex-col gap-6">
        {formError ? <FormError>{formError}</FormError> : null}

        <Field id="service-name" label="Name" error={errors.name}>
          {(props) => (
            <Input
              {...props}
              value={value.name}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder="Cut and finish"
            />
          )}
        </Field>

        <Field
          id="service-description"
          label="Description"
          optional
          hint="Shown under the service name on your booking page."
          error={errors.description}
        >
          {(props) => (
            <Textarea
              {...props}
              rows={3}
              value={value.description}
              onChange={(event) => patch({ description: event.target.value })}
              placeholder="Wash, cut and blow dry. Allow a little longer for the first visit."
            />
          )}
        </Field>

        <Field
          id="service-duration"
          label="How long it takes"
          hint={`Minutes, and a multiple of ${slotGranularityMin} — your booking interval. Anything else leaves an unsellable gap after every appointment.`}
          error={errors.durationMin}
        >
          {(props) => (
            <div className="flex flex-col gap-3">
              <Input
                {...props}
                type="number"
                inputMode="numeric"
                min={slotGranularityMin}
                max={SERVICE_MAX_DURATION_MIN}
                step={slotGranularityMin}
                value={value.durationMin}
                onChange={(event) =>
                  patch({ durationMin: Number(event.target.value) })
                }
                className="type-time max-w-[9rem]"
              />

              <div className="flex flex-wrap gap-2">
                {presets.map((minutes) => {
                  const selected = value.durationMin === minutes;

                  return (
                    <button
                      key={minutes}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => patch({ durationMin: minutes })}
                      className={
                        selected
                          ? "type-time rounded-pill border border-accent bg-accent px-4 py-2 text-accent-contrast"
                          : "type-time rounded-pill border border-line px-4 py-2 text-ink-muted transition-colors hover:bg-surface-sunk"
                      }
                    >
                      {minutes} min
                    </button>
                  );
                })}
              </div>

              {/* Advisory, live, before the save is attempted. The schema says
                  the same thing on submit and the server says it again. */}
              {offGrid && !errors.durationMin ? (
                <p className="type-body-sm text-pending">
                  {value.durationMin} min is not a whole number of{" "}
                  {slotGranularityMin}-minute intervals.
                </p>
              ) : null}
            </div>
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="service-buffer-before"
            label="Buffer before"
            error={errors.bufferBeforeMin}
          >
            {(props) => (
              <Input
                {...props}
                type="number"
                inputMode="numeric"
                min={0}
                max={SERVICE_MAX_BUFFER_MIN}
                step={5}
                value={value.bufferBeforeMin}
                onChange={(event) =>
                  patch({ bufferBeforeMin: Number(event.target.value) })
                }
                className="type-time"
              />
            )}
          </Field>

          <Field
            id="service-buffer-after"
            label="Buffer after"
            error={errors.bufferAfterMin}
          >
            {(props) => (
              <Input
                {...props}
                type="number"
                inputMode="numeric"
                min={0}
                max={SERVICE_MAX_BUFFER_MIN}
                step={5}
                value={value.bufferAfterMin}
                onChange={(event) =>
                  patch({ bufferAfterMin: Number(event.target.value) })
                }
                className="type-time"
              />
            )}
          </Field>
        </div>

        {/* The whole reason buffers are comprehensible without documentation. */}
        <BlockedTimePreview
          timing={{
            durationMin: Math.max(0, value.durationMin || 0),
            bufferBeforeMin: Math.max(0, value.bufferBeforeMin || 0),
            bufferAfterMin: Math.max(0, value.bufferAfterMin || 0),
          }}
        />

        <Field
          id="service-price"
          label={`Price in ${currency}`}
          error={errors.price}
        >
          {(props) => (
            <Input
              {...props}
              inputMode="decimal"
              value={value.price}
              onChange={(event) => patch({ price: event.target.value })}
              placeholder="45.00"
              className="type-time max-w-[11rem]"
            />
          )}
        </Field>

        <Field
          id="service-deposit-type"
          label="Deposit"
          hint="Charged when the booking is made. The rest is settled however you settle it today."
        >
          {(props) => (
            <SelectNative
              {...props}
              value={value.depositType}
              onChange={(event) =>
                patch({
                  depositType: event.target
                    .value as ServiceFormValue["depositType"],
                  // A percentage of nothing and a flat amount of nothing are
                  // both meaningless, so switching type resets the value to
                  // something sensible for the new one.
                  deposit: event.target.value === "percent" ? "20" : "0",
                })
              }
            >
              <option value="none">No deposit</option>
              <option value="flat">A fixed amount</option>
              <option value="percent">A percentage of the price</option>
            </SelectNative>
          )}
        </Field>

        {value.depositType !== "none" ? (
          <Field
            id="service-deposit"
            label={
              value.depositType === "flat"
                ? `Deposit in ${currency}`
                : "Deposit percentage"
            }
            error={errors.deposit}
          >
            {(props) => (
              <Input
                {...props}
                inputMode="decimal"
                value={value.deposit}
                onChange={(event) => patch({ deposit: event.target.value })}
                placeholder={value.depositType === "flat" ? "10.00" : "20"}
                className="type-time max-w-[11rem]"
              />
            )}
          </Field>
        ) : null}

        <Field
          id="service-staff"
          label="Who can perform it"
          hint="A service with nobody active assigned to it does not appear on your booking page."
          error={errors.staffIds}
        >
          {(props) => (
            <AssignmentPicker
              id={props.id}
              label="Who can perform it"
              options={staffOptions.map((member) => ({
                id: member.id,
                label: member.name,
                meta: member.initials,
                isInactive: !member.isActive,
              }))}
              selectedIds={value.staffIds}
              onChange={(staffIds) => patch({ staffIds })}
              emptyMessage="No staff yet. Add someone on the Staff page first."
              describedBy={props["aria-describedby"]}
            />
          )}
        </Field>

        <ToggleField
          id="service-active"
          label="Bookable"
          description={
            value.isActive
              ? "Customers can book this service."
              : "Hidden from your booking page. Appointments already made are unchanged."
          }
          checked={value.isActive}
          onCheckedChange={(isActive) => patch({ isActive })}
        />
      </div>
    </Sheet>
  );
}
