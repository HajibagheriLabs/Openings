"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  DayPicker,
  TZDate,
  type ChevronProps,
} from "react-day-picker";

import { cn } from "@/lib/utils";

/**
 * The month picker, themed to Daybook.
 *
 * react-day-picker for the grid and the keyboard model — a month calendar is
 * five hundred lines of arrow-key and roving-tabindex handling that has been
 * got right already — and nothing else. Its stylesheet is not imported; every
 * class below is ours, so the calendar inherits the same tokens as the rest of
 * the product instead of arriving with its own idea of blue.
 *
 * IT SPEAKS LOCAL DATE STRINGS, NOT `Date` OBJECTS. The server owns every
 * scheduling decision and sends "2026-09-03" — a local calendar date in the
 * BUSINESS's timezone. This component converts at its own boundary, in the two
 * functions below, and hands the rest of the application strings back. No
 * caller ever holds a `Date` whose meaning depends on where the browser is.
 *
 * The conversion is real, though, so it is done properly: `TZDate` (which
 * react-day-picker re-exports and uses internally when given a `timeZone`)
 * builds a date whose calendar fields ARE the business's. A plain `new Date()`
 * would be the visitor's calendar wearing the business's label, and would put
 * the month boundary on the wrong day for anyone far enough east or west.
 */

/** "2026-09-03" or "2026-09" to a date in the business's calendar. */
function toTZDate(value: string, timeZone: string): TZDate {
  const [year, month, day = "1"] = value.split("-");

  return new TZDate(Number(year), Number(month) - 1, Number(day), timeZone);
}

/**
 * A date back to "2026-09-03", in the business's zone.
 *
 * Formatting, not arithmetic: `Intl.DateTimeFormat` is asked which calendar
 * day this instant falls on in that zone and the answer is reassembled. The
 * parts are read individually rather than through a locale pattern, because a
 * locale is free to write the year last, and this string is a key.
 */
function toLocalDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const find = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${find("year")}-${find("month")}-${find("day")}`;
}

function Chevron({ orientation, className }: ChevronProps) {
  const Icon = orientation === "left" ? ChevronLeft : ChevronRight;

  return <Icon aria-hidden="true" className={cn("size-4", className)} />;
}

export function Calendar({
  timeZone,
  month,
  onMonthChange,
  selected,
  onSelect,
  isDisabled,
  firstMonth,
  lastMonth,
  busy = false,
  ariaLabel,
  className,
}: {
  /** IANA identifier. The grid, "today" and the day keys are all in this zone. */
  timeZone: string;
  /** The month on screen, "2026-09". */
  month: string;
  onMonthChange: (month: string) => void;
  /** "2026-09-03", or null when nothing is chosen yet. */
  selected: string | null;
  onSelect: (date: string) => void;
  /** True for a day with nothing free. Answered from server data, never guessed. */
  isDisabled: (date: string) => boolean;
  /** Navigation bounds, "2026-08" and "2026-10". */
  firstMonth: string;
  lastMonth: string;
  /** A month is being fetched. Quietens the grid without moving anything. */
  busy?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <DayPicker
      mode="single"
      timeZone={timeZone}
      month={toTZDate(month, timeZone)}
      onMonthChange={(next) => onMonthChange(toLocalDate(next, timeZone).slice(0, 7))}
      selected={selected ? toTZDate(selected, timeZone) : undefined}
      onSelect={(next) => {
        if (next) {
          onSelect(toLocalDate(next, timeZone));
        }
      }}
      disabled={(date: Date) => isDisabled(toLocalDate(date, timeZone))}
      startMonth={toTZDate(firstMonth, timeZone)}
      endMonth={toTZDate(lastMonth, timeZone)}
      /**
       * Monday first, matching the admin week everywhere else in the product.
       * A business has one week shape and it should not depend on who is
       * looking at it.
       */
      weekStartsOn={1}
      /**
       * Outside days would be drawn from a month whose availability was never
       * fetched, so every one of them would be disabled — a row of dead
       * squares that look like closed days rather than absent ones. Leaving
       * them out says nothing false.
       */
      showOutsideDays={false}
      navLayout="around"
      animate={false}
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
      components={{ Chevron }}
      className={cn("w-full select-none", busy && "opacity-60", className)}
      classNames={{
        months: "flex w-full flex-col",
        month: "flex w-full flex-col gap-3",
        month_caption:
          "relative flex h-11 items-center justify-center px-11 text-center",
        caption_label: "type-section text-ink",
        button_previous:
          "absolute left-0 top-0 inline-flex size-11 items-center justify-center rounded-pill text-ink-muted hover:bg-surface-sunk hover:text-ink aria-disabled:pointer-events-none aria-disabled:opacity-35",
        button_next:
          "absolute right-0 top-0 inline-flex size-11 items-center justify-center rounded-pill text-ink-muted hover:bg-surface-sunk hover:text-ink aria-disabled:pointer-events-none aria-disabled:opacity-35",
        month_grid: "w-full border-collapse",
        weekdays: "",
        weekday: "type-label pb-2 font-semibold",
        week: "",
        /* The cell carries the state; the button inside it is the target, and
           it is 44px tall because this is booked on a phone. */
        day: "group/day p-0.5 align-middle",
        day_button: cn(
          "type-time relative flex h-11 w-full items-center justify-center rounded-pill",
          /* OPEN TIME, the same encoding the ribbon uses: accent wash under a
             1px accent border. The calendar and the day agree about what an
             opening looks like. */
          "border border-accent bg-accent-wash text-ink hover:bg-accent/20",
          "group-data-[selected=true]/day:border-accent group-data-[selected=true]/day:bg-accent group-data-[selected=true]/day:text-accent-contrast",
          /* Nothing free: quiet, and genuinely inert. No fill, no border, no
             pointer — a day you cannot book should not look like a day you
             merely have not booked. */
          "disabled:cursor-default disabled:border-transparent disabled:bg-transparent disabled:text-ink-faint disabled:opacity-45 disabled:hover:bg-transparent",
          /* Today, marked by a dot rather than a colour. */
          "after:absolute after:bottom-1 after:hidden after:size-1 after:rounded-pill after:bg-ink-faint after:content-['']",
          "group-data-[today=true]/day:after:block",
          "group-data-[selected=true]/day:after:bg-accent-contrast",
        ),
      }}
    />
  );
}
