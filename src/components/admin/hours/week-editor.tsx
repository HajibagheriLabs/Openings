"use client";

import { Copy, Plus, X } from "lucide-react";

import { PillButton } from "@/components/pill-button";
import { ToggleSwitch } from "@/components/toggle-switch";
import { Input } from "@/components/ui/input";
import {
  BUSINESS_WEEKDAYS,
  crossesMidnight,
  WEEKDAYS_DISPLAY_ORDER,
  WEEKDAY_NAMES,
} from "@/lib/scheduling/week";
import { cn } from "@/lib/utils";

/**
 * The weekly grid.
 *
 * ONE DAY IS A LIST OF INTERVALS, AND THAT IS THE WHOLE MODEL. A lunch break
 * is not a concept here — it is the gap between 09:00–13:00 and 14:00–18:00,
 * two ordinary rows. Keeping the model that simple is what lets the exclusion
 * of a break, a split shift, a market stall that opens twice and a night shift
 * all be the same three columns in `availability_rules`, with no special cases
 * anywhere downstream.
 *
 * Closed is the absence of intervals, not a flag. The switch adds a default
 * interval or clears them all, so the form state and the stored rows always
 * say the same thing.
 */

export interface EditorDay {
  weekday: number;
  intervals: { startLocal: string; endLocal: string }[];
}

const DEFAULT_INTERVAL = { startLocal: "09:00", endLocal: "17:00" };

export function WeekEditor({
  days,
  dayErrors,
  onChange,
  disabled,
}: {
  days: EditorDay[];
  /** Weekday index to message, from the schema or the server. */
  dayErrors: Record<number, string>;
  onChange: (days: EditorDay[]) => void;
  disabled?: boolean;
}) {
  function updateDay(weekday: number, intervals: EditorDay["intervals"]): void {
    onChange(
      days.map((day) => (day.weekday === weekday ? { ...day, intervals } : day)),
    );
  }

  /**
   * "Copy Monday to all weekdays" — the thing everyone actually wants.
   *
   * Monday to Friday only. A business whose Saturday matches its Monday is
   * rare enough that overwriting the weekend would be a nasty surprise, and
   * the two days most likely to hold a carefully-set half day are exactly the
   * two this leaves alone.
   */
  function copyMondayToWeekdays(): void {
    const monday = days.find((day) => day.weekday === 1);

    if (!monday) {
      return;
    }

    onChange(
      days.map((day) =>
        BUSINESS_WEEKDAYS.includes(day.weekday as 1 | 2 | 3 | 4 | 5)
          ? {
              ...day,
              // Cloned, not shared: editing Tuesday later must not move Monday.
              intervals: monday.intervals.map((interval) => ({ ...interval })),
            }
          : day,
      ),
    );
  }

  const monday = days.find((day) => day.weekday === 1);
  const canCopy = (monday?.intervals.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="type-body-sm text-ink-muted">
          A break is the gap between two periods — add a second period rather
          than looking for a break setting.
        </p>

        <PillButton
          variant="secondary"
          size="sm"
          onClick={copyMondayToWeekdays}
          disabled={disabled || !canCopy}
          title={
            canCopy ? undefined : "Set Monday's hours first, then copy them."
          }
        >
          <Copy aria-hidden="true" />
          Copy Monday to Mon–Fri
        </PillButton>
      </div>

      <ul className="flex flex-col gap-3">
        {WEEKDAYS_DISPLAY_ORDER.map((weekday) => {
          const day = days.find((candidate) => candidate.weekday === weekday);

          if (!day) {
            return null;
          }

          return (
            <DayRow
              key={weekday}
              day={day}
              error={dayErrors[weekday]}
              disabled={disabled}
              onChange={(intervals) => updateDay(weekday, intervals)}
            />
          );
        })}
      </ul>
    </div>
  );
}

function DayRow({
  day,
  error,
  disabled,
  onChange,
}: {
  day: EditorDay;
  error?: string;
  disabled?: boolean;
  onChange: (intervals: EditorDay["intervals"]) => void;
}) {
  const name = WEEKDAY_NAMES[day.weekday];
  const isOpen = day.intervals.length > 0;

  function setInterval(
    index: number,
    patch: Partial<{ startLocal: string; endLocal: string }>,
  ): void {
    onChange(
      day.intervals.map((interval, position) =>
        position === index ? { ...interval, ...patch } : interval,
      ),
    );
  }

  function addInterval(): void {
    const last = day.intervals[day.intervals.length - 1];

    // A second period starts where a lunch break would end, not on top of the
    // first one — the common case shaped in, so the owner adjusts rather than
    // types from scratch.
    onChange([
      ...day.intervals,
      last
        ? { startLocal: last.endLocal, endLocal: "18:00" }
        : { ...DEFAULT_INTERVAL },
    ]);
  }

  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-card border bg-surface p-4",
        error ? "border-cancelled" : "border-line",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ToggleSwitch
            checked={isOpen}
            disabled={disabled}
            onCheckedChange={(open) =>
              onChange(open ? [{ ...DEFAULT_INTERVAL }] : [])
            }
            label={`Open on ${name.label}`}
          />

          <span className="type-section w-24 text-ink">{name.label}</span>

          {!isOpen ? (
            <span className="type-body-sm text-ink-faint">Closed</span>
          ) : null}
        </div>

        {isOpen ? (
          <PillButton
            variant="quiet"
            size="sm"
            onClick={addInterval}
            disabled={disabled || day.intervals.length >= 4}
          >
            <Plus aria-hidden="true" />
            Add a period
          </PillButton>
        ) : null}
      </div>

      {isOpen ? (
        <div className="flex flex-col gap-2">
          {day.intervals.map((interval, index) => {
            const overnight = crossesMidnight({
              weekday: day.weekday,
              startLocal: interval.startLocal,
              endLocal: interval.endLocal,
            });

            return (
              <div
                key={index}
                className="flex flex-wrap items-center gap-2"
              >
                <Input
                  type="time"
                  value={interval.startLocal}
                  disabled={disabled}
                  onChange={(event) =>
                    setInterval(index, { startLocal: event.target.value })
                  }
                  aria-label={`${name.label} period ${index + 1} opens`}
                  className="type-time w-[8.5rem]"
                />

                <span aria-hidden="true" className="type-body text-ink-faint">
                  to
                </span>

                <Input
                  type="time"
                  value={interval.endLocal}
                  disabled={disabled}
                  onChange={(event) =>
                    setInterval(index, { endLocal: event.target.value })
                  }
                  aria-label={`${name.label} period ${index + 1} closes`}
                  className="type-time w-[8.5rem]"
                />

                {/* Stated, not hidden. A shift ending before it starts is
                    legal here and means the next day — the owner should never
                    have to infer that from a form that looks broken. */}
                {overnight ? (
                  <span className="type-body-sm text-ink-muted">
                    ends the next morning
                  </span>
                ) : null}

                <PillButton
                  variant="quiet"
                  size="icon-sm"
                  disabled={disabled}
                  onClick={() =>
                    onChange(day.intervals.filter((_, i) => i !== index))
                  }
                  aria-label={`Remove ${name.label} period ${index + 1}`}
                  className="ml-auto"
                >
                  <X aria-hidden="true" />
                </PillButton>
              </div>
            );
          })}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="type-body-sm text-cancelled">
          {error}
        </p>
      ) : null}
    </li>
  );
}
