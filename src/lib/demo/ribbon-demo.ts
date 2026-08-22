import "server-only";

import type { RibbonColumn, RibbonSegment } from "@/components/ribbon";
import { Temporal } from "@/lib/scheduling/temporal";

/**
 * STATIC DEMO DATA, so the Ribbon can be looked at before the availability
 * algorithm exists. Delete this module the day src/lib/scheduling starts
 * producing real segments.
 *
 * It is nonetheless written the way the real thing will be, because that is
 * the point of building it here: EVERY DATE CALCULATION HAPPENS ON THE SERVER,
 * in the business's timezone, with a DST-correct API. What crosses into the
 * component is minutes-since-local-midnight for geometry and ISO instants for
 * labels — never a wall-clock string, and never a job for the client.
 */

/** A slot described the way a human would, in local wall-clock time. */
interface DemoSpan {
  startHour: number;
  startMinute?: number;
  durationMin: number;
  state: RibbonSegment["state"];
  label?: string;
  isPast?: boolean;
  holdRemaining?: number;
}

/**
 * Local wall-clock to a real instant, in the business's zone.
 *
 * `Temporal.PlainDate.toZonedDateTime` is what makes this DST-correct: on the
 * two days a year when a local time is ambiguous or does not exist, it
 * resolves by an explicit documented rule rather than by silently adding an
 * offset that happens to be wrong for half the year.
 */
function instantAt(
  date: Temporal.PlainDate,
  timeZone: string,
  minuteOfDay: number,
): string {
  return date
    .toZonedDateTime({
      timeZone,
      plainTime: new Temporal.PlainTime(
        Math.floor(minuteOfDay / 60),
        minuteOfDay % 60,
      ),
    })
    .toInstant()
    .toString();
}

function buildSegments(
  spans: DemoSpan[],
  date: Temporal.PlainDate,
  timeZone: string,
  columnId: string,
): RibbonSegment[] {
  return spans.map((span, index) => {
    const startMinute = span.startHour * 60 + (span.startMinute ?? 0);

    return {
      id: `${columnId}-${index}`,
      state: span.state,
      startMinute,
      durationMin: span.durationMin,
      startsAt: instantAt(date, timeZone, startMinute),
      endsAt: instantAt(date, timeZone, startMinute + span.durationMin),
      label: span.label,
      isPast: span.isPast,
      holdRemaining: span.holdRemaining,
    };
  });
}

export interface DemoDay {
  window: { startMinute: number; endMinute: number };
  columns: RibbonColumn[];
  /**
   * Minutes since local midnight, in the business's zone — where the now line
   * goes. NULL on a day that is not today, because there is no "now" on a
   * Thursday next month and drawing one would be a line across a lie.
   */
  nowMinute: number | null;
  /** The day being shown, as an instant, for date headings. */
  dayInstant: string;
}

/**
 * The admin agenda: several staff, a full day, every state represented.
 *
 * Deliberately includes a 15-minute segment, because that is 24px at the
 * default scale and it is the case the hit-area expansion exists for.
 */
export function buildAdminDemoDay(
  timeZone: string,
  staff: { id: string; name: string; initials: string }[],
): DemoDay {
  const today = Temporal.Now.plainDateISO(timeZone);
  const nowTime = Temporal.Now.plainTimeISO(timeZone);
  const nowMinute = nowTime.hour * 60 + nowTime.minute;

  const window = { startMinute: 8 * 60, endMinute: 19 * 60 };

  const rosters: DemoSpan[][] = [
    [
      { startHour: 9, durationMin: 60, state: "booked", label: "MR", isPast: true },
      { startHour: 10, startMinute: 15, durationMin: 90, state: "booked", label: "TL" },
      { startHour: 12, durationMin: 45, state: "blocked", label: "Lunch" },
      { startHour: 13, durationMin: 15, state: "open" },
      { startHour: 13, startMinute: 30, durationMin: 90, state: "open" },
      { startHour: 15, startMinute: 30, durationMin: 60, state: "held" },
      { startHour: 17, durationMin: 45, state: "booked", label: "PK" },
    ],
    [
      { startHour: 8, startMinute: 30, durationMin: 30, state: "booked", label: "AS", isPast: true },
      { startHour: 10, durationMin: 120, state: "blocked", label: "Training" },
      { startHour: 12, startMinute: 30, durationMin: 45, state: "open" },
      { startHour: 14, durationMin: 60, state: "booked", label: "JD" },
      { startHour: 15, startMinute: 15, durationMin: 30, state: "open" },
      { startHour: 16, durationMin: 90, state: "open" },
    ],
    [
      { startHour: 9, startMinute: 30, durationMin: 45, state: "booked", label: "CN", isPast: true },
      { startHour: 11, durationMin: 30, state: "open" },
      { startHour: 11, startMinute: 45, durationMin: 60, state: "held" },
      { startHour: 13, durationMin: 240, state: "blocked", label: "Away" },
      { startHour: 17, startMinute: 30, durationMin: 30, state: "open" },
    ],
  ];

  return {
    window,
    nowMinute,
    dayInstant: instantAt(today, timeZone, nowMinute),
    columns: staff.map((member, index) => ({
      id: member.id,
      label: member.name,
      sublabel: member.initials,
      segments: buildSegments(
        rosters[index % rosters.length],
        today,
        timeZone,
        member.id,
      ),
    })),
  };
}

/**
 * The customer's picker: one column, one service length, and one slot already
 * held so the depleting bar has something to show.
 *
 * The DAY is real — it is whichever date the visitor chose on the month
 * picker, resolved in the business's zone — and so is the fact of whether that
 * day is today. Only the slots are invented. That split is deliberate: when
 * the real segments arrive, the surrounding page does not change shape.
 */
export function buildBookingDemoDay(
  timeZone: string,
  serviceDurationMin: number,
  /** A LOCAL calendar date in the business's zone, "2026-09-03". */
  date: string,
): DemoDay {
  const day = Temporal.PlainDate.from(date);
  const today = Temporal.Now.plainDateISO(timeZone);
  const isToday = day.equals(today);

  const nowTime = Temporal.Now.plainTimeISO(timeZone);
  const nowMinute = isToday ? nowTime.hour * 60 + nowTime.minute : null;

  const window = { startMinute: 9 * 60, endMinute: 18 * 60 };

  const spans: DemoSpan[] = [
    // Nine o'clock has already gone only if the day in question is today.
    {
      startHour: 9,
      durationMin: serviceDurationMin,
      state: isToday ? "past" : "open",
    },
    { startHour: 10, startMinute: 30, durationMin: serviceDurationMin, state: "open" },
    { startHour: 12, durationMin: 60, state: "booked", label: "Taken" },
    { startHour: 13, startMinute: 15, durationMin: serviceDurationMin, state: "selected", holdRemaining: 0.62 },
    { startHour: 15, durationMin: serviceDurationMin, state: "held" },
    { startHour: 16, startMinute: 30, durationMin: serviceDurationMin, state: "open" },
  ];

  return {
    window,
    nowMinute,
    dayInstant: instantAt(day, timeZone, window.startMinute),
    columns: [
      {
        id: "any",
        label: "Chosen day",
        segments: buildSegments(spans, day, timeZone, "any"),
      },
    ],
  };
}
