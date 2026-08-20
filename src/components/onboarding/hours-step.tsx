"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { WEEKDAYS } from "@/lib/validation/onboarding";

import type { FieldErrors, HoursStepValue } from "./types";

/**
 * Step 2 — the weekly opening hours.
 *
 * What these are NOT: instants. They are plain local wall-clock times in the
 * business's timezone, stored on `availability_rules` exactly as typed. "We
 * open at 9" has to still mean nine o'clock the morning after the clocks
 * change, and a stored instant would silently become eight or ten. The server
 * expands these into real instants per day, in the business's zone, with a
 * DST-aware API.
 *
 * They seed the owner's own staff row. A second person hired later gets their
 * own rules; nothing about this screen is business-wide.
 */
export function HoursStep({
  value,
  errors,
  timezone,
  onChange,
}: {
  value: HoursStepValue;
  errors: FieldErrors;
  /** Shown, not used — the arithmetic all happens on the server. */
  timezone: string;
  onChange: (next: HoursStepValue) => void;
}) {
  function updateDay(weekday: number, patch: Partial<HoursStepValue[number]>) {
    onChange(
      value.map((day) =>
        day.weekday === weekday ? { ...day, ...patch } : day,
      ),
    );
  }

  /** The overwhelmingly common case: the same hours every day you are open. */
  function copyFirstOpenDayToAll() {
    const source = value.find((day) => day.isOpen);

    if (!source) {
      return;
    }

    onChange(
      value.map((day) =>
        day.isOpen
          ? { ...day, startLocal: source.startLocal, endLocal: source.endLocal }
          : day,
      ),
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="type-page-title text-ink">Opening hours</h2>
        <p className="type-body text-ink-muted">
          Your normal week. Holidays and one-off closures come later — this is
          the pattern everything else works from.
        </p>
        {timezone ? (
          <p className="type-body-sm text-ink-faint">
            Local time in {timezone.replace(/_/g, " ")}.
          </p>
        ) : null}
      </div>

      {errors.root ? (
        <p role="alert" className="type-body-sm text-cancelled">
          {errors.root}
        </p>
      ) : null}

      <ul className="flex flex-col gap-3">
        {WEEKDAYS.map(({ weekday, label }) => {
          const day = value.find((entry) => entry.weekday === weekday);

          if (!day) {
            return null;
          }

          const dayError = errors[String(weekday)];

          return (
            <li
              key={weekday}
              className="flex flex-col gap-2 rounded-card border border-line bg-surface px-4 py-3"
            >
              <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                <label className="flex min-w-[7.5rem] cursor-pointer items-center gap-3">
                  <Checkbox
                    checked={day.isOpen}
                    onCheckedChange={(checked) =>
                      updateDay(weekday, { isOpen: checked === true })
                    }
                  />
                  <span className="type-section text-ink">{label}</span>
                </label>

                {day.isOpen ? (
                  <div className="flex flex-1 items-center gap-2">
                    <Input
                      type="time"
                      aria-label={`${label} opening time`}
                      value={day.startLocal}
                      onChange={(event) =>
                        updateDay(weekday, { startLocal: event.target.value })
                      }
                      aria-invalid={dayError ? true : undefined}
                      className="type-time max-w-[9rem]"
                    />
                    <span aria-hidden="true" className="type-body text-ink-faint">
                      to
                    </span>
                    <Input
                      type="time"
                      aria-label={`${label} closing time`}
                      value={day.endLocal}
                      onChange={(event) =>
                        updateDay(weekday, { endLocal: event.target.value })
                      }
                      aria-invalid={dayError ? true : undefined}
                      className="type-time max-w-[9rem]"
                    />
                  </div>
                ) : (
                  <span className="type-body text-ink-faint">Closed</span>
                )}
              </div>

              {dayError ? (
                <p className="type-body-sm text-cancelled">{dayError}</p>
              ) : null}
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        onClick={copyFirstOpenDayToAll}
        className="type-body-sm w-fit rounded-pill border border-line px-4 py-2 text-ink-muted transition-colors hover:bg-surface-sunk"
      >
        Use the first open day&rsquo;s hours everywhere
      </button>
    </div>
  );
}
