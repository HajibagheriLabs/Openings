"use client";

import { Field } from "@/components/field";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { CURRENCIES } from "@/lib/money";

import type { FieldErrors, ServiceStepValue } from "./types";

/** Common lengths, plus anything typed by hand in the minutes box. */
const DURATION_PRESETS = [15, 20, 30, 45, 60, 90, 120];

/**
 * Step 3 — one service, so the booking page has something to offer.
 *
 * Buffers are not asked for here. They matter enormously — they are folded
 * into the blocking range so the database enforces them — but they are the
 * kind of thing an owner tunes after watching a week of bookings, not
 * something to explain in a two-minute setup. They default to zero and live in
 * the service settings.
 */
export function ServiceStep({
  value,
  errors,
  onChange,
}: {
  value: ServiceStepValue;
  errors: FieldErrors;
  onChange: (next: ServiceStepValue) => void;
}) {
  const currency =
    CURRENCIES.find((entry) => entry.code === value.currency) ?? CURRENCIES[0];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="type-page-title text-ink">Your first service</h2>
        <p className="type-body text-ink-muted">
          One is enough to start taking bookings. Add the rest whenever you
          like.
        </p>
      </div>

      <Field id="service-name" label="Service name" error={errors.name}>
        {(props) => (
          <Input
            {...props}
            value={value.name}
            onChange={(event) => onChange({ ...value, name: event.target.value })}
            placeholder="Cut and finish"
            autoFocus
          />
        )}
      </Field>

      <Field
        id="service-duration"
        label="How long it takes"
        hint="In minutes. This is the time the customer is booking."
        error={errors.durationMin}
      >
        {(props) => (
          <div className="flex flex-col gap-3">
            <Input
              {...props}
              type="number"
              inputMode="numeric"
              min={5}
              max={600}
              step={5}
              value={value.durationMin}
              onChange={(event) =>
                onChange({
                  ...value,
                  durationMin: Number(event.target.value),
                })
              }
              className="type-time max-w-[9rem]"
            />

            <div className="flex flex-wrap gap-2">
              {DURATION_PRESETS.map((minutes) => {
                const selected = value.durationMin === minutes;

                return (
                  <button
                    key={minutes}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onChange({ ...value, durationMin: minutes })}
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
          </div>
        )}
      </Field>

      <Field id="service-currency" label="Currency">
        {(props) => (
          <SelectNative
            {...props}
            value={value.currency}
            onChange={(event) =>
              onChange({ ...value, currency: event.target.value })
            }
          >
            {CURRENCIES.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {entry.code} — {entry.label}
              </option>
            ))}
          </SelectNative>
        )}
      </Field>

      <Field
        id="service-price"
        label={`Price in ${currency.code}`}
        error={errors.price}
      >
        {(props) => (
          <Input
            {...props}
            inputMode="decimal"
            value={value.price}
            onChange={(event) =>
              onChange({ ...value, price: event.target.value })
            }
            placeholder="45.00"
            className="type-time max-w-[11rem]"
          />
        )}
      </Field>

      <Field
        id="service-deposit-type"
        label="Deposit"
        hint="A deposit is charged when the booking is made. The rest is settled however you settle it today."
      >
        {(props) => (
          <SelectNative
            {...props}
            value={value.depositType}
            onChange={(event) =>
              onChange({
                ...value,
                depositType: event.target
                  .value as ServiceStepValue["depositType"],
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
              ? `Deposit in ${currency.code}`
              : "Deposit percentage"
          }
          error={errors.deposit}
        >
          {(props) => (
            <Input
              {...props}
              inputMode="decimal"
              value={value.deposit}
              onChange={(event) =>
                onChange({ ...value, deposit: event.target.value })
              }
              placeholder={value.depositType === "flat" ? "10.00" : "20"}
              className="type-time max-w-[11rem]"
            />
          )}
        </Field>
      ) : null}
    </div>
  );
}
