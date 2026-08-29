import type { RibbonColumn, RibbonSegment } from "@/components/ribbon";
import type { AppointmentStatus } from "@/db/schema";
/* Defined in the shared vocabulary module rather than here, because the Today
   panel renders it and this file reaches Temporal. See the note beside it. */
import { GAP_THRESHOLD_MIN } from "@/lib/admin/calendar";

import {
  clipSpans,
  mergeSpans,
  subtractSpans,
  type Span,
} from "./availability";
import { ceilHour, floorHour, localMinuteOf } from "./local-minutes";
import type { TimeZoneId } from "./temporal";

/* ===========================================================================
   THE MASTER SCHEDULE, SHAPED FOR THE RIBBON.
   ---------------------------------------------------------------------------
   PURE. Every row this module works on has already been loaded, and the clock
   has already been read (src/server/queries/agenda.ts does both). Nothing here
   opens a connection, and nothing here calls Date.now() — which is what lets
   the awkward parts (a booking that starts before the shop opens, a closure
   that spans midnight, a gap that only exists after lunch) be pinned down as
   ordinary unit tests instead of fixtures that rot with the calendar.

   IT PRODUCES RIBBON COLUMNS AND NOTHING ELSE. The same component, at the same
   pixels-per-minute, draws the customer's day picker and this. The day view is
   one column per staff member; the week view is seven columns, one per local
   day. Only the number of columns changes — which is the whole reason the
   Ribbon was built to be dumb.
   =========================================================================== */

/** Who has a lane in the day view. Active staff, in display order. */
export interface AgendaStaff {
  id: string;
  name: string;
  initials: string;
}

/**
 * One appointment as the agenda needs it.
 *
 * TWO SPANS, AND THEY ARE NOT THE SAME. `startsAt`/`endsAt` are what the
 * customer was told and what the segment is labelled with. `slotStartsAt`/
 * `slotEndsAt` are the stored blocking range, buffers included, and they are
 * what gets subtracted from open time — otherwise a fifteen-minute cleanup
 * buffer would be drawn as bookable and the owner would be offered a slot the
 * database will refuse.
 */
export interface AgendaAppointment {
  id: string;
  staffId: string;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  slotStartsAt: string;
  slotEndsAt: string;
  serviceName: string;
  /** Null only for a hold nobody has put a name to yet. */
  customerName: string | null;
  customerInitials: string | null;
  priceCents: number;
  depositCents: number;
  /**
   * A hold whose deadline has NOT passed, decided against the injected clock.
   *
   * An expired hold blocks nothing — the availability query ignores it and the
   * next booking transaction sweeps it — so drawing one would be drawing a
   * slot that is genuinely free. The loader decides this; the shaping trusts.
   */
  isLiveHold: boolean;
}

/** A closure. `staffId: null` shuts the whole business. */
export interface AgendaClosure {
  id: string;
  staffId: string | null;
  startsAt: string;
  endsAt: string;
  reason: string | null;
}

export interface AgendaDayInput {
  /** Local calendar date in the business timezone, "2026-08-29". */
  date: string;
  timeZone: TimeZoneId;
  staff: AgendaStaff[];
  /** Rostered hours per staff id, already expanded into instants. */
  openByStaff: Map<string, Span[]>;
  appointments: AgendaAppointment[];
  closures: AgendaClosure[];
  /** The instant window of this local day, `[startOfDay, startOfNextDay)`. */
  dayWindow: Span;
  /** Injected clock. Decides `isPast` and the now line, nothing else. */
  now: Date;
}

export interface AgendaDay {
  date: string;
  timeZone: TimeZoneId;
  /** An instant on that day, for formatting the heading. */
  dayInstant: string;
  window: { startMinute: number; endMinute: number };
  /** Where the now line goes, or null when the day is not today. */
  nowMinute: number | null;
  columns: RibbonColumn[];
}

/* ---------------------------------------------------------------------------
   Building the day
--------------------------------------------------------------------------- */

/** The three states of an appointment that still occupies its time. */
const DRAWN_STATUSES: ReadonlySet<AppointmentStatus> = new Set<AppointmentStatus>(
  ["confirmed", "completed", "no_show"],
);

/**
 * A cancelled appointment is NOT drawn.
 *
 * The exclusion constraint does not cover `cancelled`, so that time is
 * genuinely back in the day and something else can be booked into it. Drawing
 * it would put a block on the calendar over time the owner is free to sell,
 * which is the same lie in the other direction from double-booking.
 */
export function occupiesTime(
  appointment: Pick<AgendaAppointment, "status" | "isLiveHold">,
): boolean {
  return (
    DRAWN_STATUSES.has(appointment.status) ||
    (appointment.status === "held" && appointment.isLiveHold)
  );
}

/** The label on a booked segment: who it is, and what they are in for. */
export function segmentLabel(appointment: AgendaAppointment): string {
  const initials = appointment.customerInitials?.trim();

  return initials
    ? `${initials} · ${appointment.serviceName}`
    : appointment.serviceName;
}

/**
 * One local day, one column per staff member.
 *
 * SEGMENT ORDER IS PAINT ORDER. They are absolutely positioned in the column,
 * so a later one draws over an earlier one: open time first (it is the
 * background the rest is carved out of), then closures, then holds, then
 * appointments. A booking always wins the pixel it shares with anything else,
 * because a booking is the fact the owner came to read.
 */
export function buildAgendaDay(input: AgendaDayInput): AgendaDay {
  const { date, timeZone, dayWindow } = input;
  const minuteOf = (instant: string | Date) =>
    localMinuteOf(instant, date, timeZone);

  const nowMs = input.now.getTime();
  const columns: RibbonColumn[] = [];

  for (const member of input.staff) {
    const live = input.appointments.filter(
      (appointment) =>
        appointment.staffId === member.id && occupiesTime(appointment),
    );

    /* Closures that apply to this lane: the business-wide ones plus their own. */
    const closures = input.closures.filter(
      (closure) => closure.staffId === null || closure.staffId === member.id,
    );

    /* Rostered hours, clipped to the day the column is drawing. A shift that
       started last night is only this column's business for the part of it
       that lands after local midnight. */
    const rostered = clipSpans(
      mergeSpans(input.openByStaff.get(member.id) ?? []),
      dayWindow,
    );

    /* THE BLOCKING RANGE, not the customer-facing one. Buffers are inside the
       stored slot and they are working time; subtracting the shorter span
       would draw cleanup time as open. */
    const busy: Span[] = live.map((appointment) => ({
      start: Date.parse(appointment.slotStartsAt),
      end: Date.parse(appointment.slotEndsAt),
    }));

    const closed: Span[] = closures.map((closure) => ({
      start: Date.parse(closure.startsAt),
      end: Date.parse(closure.endsAt),
    }));

    const free = subtractSpans(rostered, [...busy, ...closed]);

    const segments: RibbonSegment[] = [];

    /* 1. Open time — what is left to sell. */
    for (const span of free) {
      const piece = clipToDay(span, dayWindow, minuteOf);

      if (piece) {
        segments.push({
          id: `open-${member.id}-${piece.startsAt}`,
          state: "open",
          ...piece,
          label: "Open",
          isPast: span.end <= nowMs,
        });
      }
    }

    /* 2. Closures, drawn only where they actually remove something. A holiday
          at three in the morning is true and worth nothing on screen. */
    for (const closure of closures) {
      const piece = clipToDay(
        { start: Date.parse(closure.startsAt), end: Date.parse(closure.endsAt) },
        dayWindow,
        minuteOf,
      );

      if (piece) {
        segments.push({
          id: `off-${closure.id}-${member.id}`,
          state: "blocked",
          ...piece,
          label: closure.reason ?? "Blocked",
          isPast: Date.parse(closure.endsAt) <= nowMs,
        });
      }
    }

    /* 3. Holds, then 4. appointments. Drawn on the CUSTOMER-FACING span: the
          owner is looking at when somebody is in the chair, not at when the
          database stops accepting neighbours. */
    for (const appointment of live) {
      const piece = clipToDay(
        {
          start: Date.parse(appointment.startsAt),
          end: Date.parse(appointment.endsAt),
        },
        dayWindow,
        minuteOf,
      );

      if (!piece) {
        continue;
      }

      const held = appointment.status === "held";

      segments.push({
        id: appointment.id,
        state: held ? "held" : "booked",
        ...piece,
        label: held ? "Holding — not paid yet" : segmentLabel(appointment),
        isPast: Date.parse(appointment.endsAt) <= nowMs,
        /**
         * Pressable, which the customer's picker would never make a booked
         * segment — and pressable EVEN WHEN PAST, which it would never make
         * anything. "Mark as a no-show" is a decision taken after the
         * appointment did not happen, so this morning's ten o'clock has to
         * stay reachable. It is still drawn at 45%, because it is still over.
         */
        selectable: true,
      });
    }

    // Holds before appointments, so a booking overlapping a stale-looking hold
    // is the one on top. Everything else is already in paint order.
    segments.sort((a, b) => paintRank(a.state) - paintRank(b.state));

    columns.push({
      id: member.id,
      label: member.name,
      sublabel: member.initials,
      segments,
    });
  }

  return {
    date,
    timeZone,
    dayInstant: new Date(dayWindow.start + 12 * 60 * 60_000).toISOString(),
    window: windowFor(columns),
    nowMinute: nowMinuteFor(input.now, date, timeZone, dayWindow),
    columns,
  };
}

/** Later means on top. See the note on `buildAgendaDay`. */
const PAINT_ORDER: RibbonSegment["state"][] = [
  "open",
  "past",
  "blocked",
  "selected",
  "held",
  "booked",
];

function paintRank(state: RibbonSegment["state"]): number {
  return PAINT_ORDER.indexOf(state);
}

/* ---------------------------------------------------------------------------
   The week
--------------------------------------------------------------------------- */

export interface AgendaWeekInput {
  /** The seven local dates, Monday first. */
  dates: string[];
  timeZone: TimeZoneId;
  staff: AgendaStaff[];
  openByStaff: Map<string, Span[]>;
  appointments: AgendaAppointment[];
  closures: AgendaClosure[];
  /** One instant window per date, in the same order. */
  dayWindows: Span[];
  now: Date;
  /**
   * True when the calendar is filtered to a single staff member.
   *
   * IT CHANGES WHAT A SEGMENT MEANS, so it is a parameter rather than
   * something inferred from `staff.length === 1`. See `buildAgendaWeek`.
   */
  singleStaff: boolean;
}

export interface AgendaWeek {
  timeZone: TimeZoneId;
  dates: string[];
  columns: RibbonColumn[];
  window: { startMinute: number; endMinute: number };
  /** Only set when today is one of the seven days. */
  nowMinute: number | null;
  /** Index of today's column, or -1. */
  todayIndex: number;
}

/**
 * Seven compressed day columns.
 *
 * ═══ WHY A WEEK COLUMN IS NOT A DAY COLUMN WITH MORE STAFF IN IT ═══
 *
 * The Ribbon draws segments absolutely inside a column, so two appointments
 * that overlap in time overlap on screen. In the day view that never happens:
 * one column is one staff member, and the exclusion constraint guarantees that
 * one staff member cannot have two overlapping appointments. A week column is a
 * whole day for the WHOLE BUSINESS, and three people working at ten o'clock is
 * completely ordinary — so drawing them individually would stack three
 * segments on the same pixels and show one.
 *
 * So the week says a different, true thing. Filtered to one person it draws
 * their appointments individually, exactly as the day view does. Unfiltered it
 * MERGES the busy time into bands and labels each with how many appointments
 * are inside it — "3 booked" — which is the honest answer to "how full is
 * Thursday" and the question the week view is actually asked. Clicking a band
 * goes to that day, where the detail lives.
 */
export function buildAgendaWeek(input: AgendaWeekInput): AgendaWeek {
  const nowMs = input.now.getTime();
  const columns: RibbonColumn[] = [];

  input.dates.forEach((date, index) => {
    const dayWindow = input.dayWindows[index];
    const minuteOf = (instant: string | Date) =>
      localMinuteOf(instant, date, input.timeZone);

    const live = input.appointments.filter(occupiesTime);

    /* The union of everybody's shift. "The shop is open" is the fact a week
       column states; whose shift it is belongs to the day view. */
    const rostered = clipSpans(
      mergeSpans(
        input.staff.flatMap((member) => input.openByStaff.get(member.id) ?? []),
      ),
      dayWindow,
    );

    const busy = mergeSpans(
      live.map((appointment) => ({
        start: Date.parse(appointment.slotStartsAt),
        end: Date.parse(appointment.slotEndsAt),
      })),
    );

    /* Only closures that shut EVERYBODY count at week scale. One person's
       afternoon off does not close the shop, and drawing it as though it did
       would be the week view's version of a lie. */
    const closed = mergeSpans(
      input.closures
        .filter((closure) => closure.staffId === null)
        .map((closure) => ({
          start: Date.parse(closure.startsAt),
          end: Date.parse(closure.endsAt),
        })),
    );

    const segments: RibbonSegment[] = [];

    for (const span of subtractSpans(rostered, [...busy, ...closed])) {
      const piece = clipToDay(span, dayWindow, minuteOf);

      if (piece) {
        segments.push({
          id: `open-${date}-${piece.startsAt}`,
          state: "open",
          ...piece,
          label: "Open",
          isPast: span.end <= nowMs,
        });
      }
    }

    for (const closure of input.closures.filter(
      (candidate) => candidate.staffId === null,
    )) {
      const piece = clipToDay(
        { start: Date.parse(closure.startsAt), end: Date.parse(closure.endsAt) },
        dayWindow,
        minuteOf,
      );

      if (piece) {
        segments.push({
          id: `off-${closure.id}-${date}`,
          state: "blocked",
          ...piece,
          label: closure.reason ?? "Closed",
          isPast: Date.parse(closure.endsAt) <= nowMs,
        });
      }
    }

    if (input.singleStaff) {
      for (const appointment of live) {
        const piece = clipToDay(
          {
            start: Date.parse(appointment.startsAt),
            end: Date.parse(appointment.endsAt),
          },
          dayWindow,
          minuteOf,
        );

        if (piece) {
          segments.push({
            id: `${appointment.id}-${date}`,
            state: appointment.status === "held" ? "held" : "booked",
            ...piece,
            label:
              appointment.status === "held"
                ? "Holding"
                : segmentLabel(appointment),
            isPast: Date.parse(appointment.endsAt) <= nowMs,
            selectable: true,
          });
        }
      }
    } else {
      /* Merged bands, counted. `busy` is already the union of the blocking
         ranges, so a band is exactly "somebody is working here". */
      for (const band of clipSpans(busy, dayWindow)) {
        const piece = clipToDay(band, dayWindow, minuteOf);

        if (!piece) {
          continue;
        }

        const inside = live.filter(
          (appointment) =>
            Date.parse(appointment.slotStartsAt) < band.end &&
            Date.parse(appointment.slotEndsAt) > band.start,
        );

        segments.push({
          id: `busy-${date}-${band.start}`,
          state: "booked",
          ...piece,
          label:
            inside.length === 1
              ? segmentLabel(inside[0])
              : `${inside.length} booked`,
          isPast: band.end <= nowMs,
          /* Pressable, but it opens the DAY rather than an appointment — a
             band covering three people has nothing single to open. The week is
             a map; the day is the workspace. */
          selectable: true,
        });
      }
    }

    segments.sort((a, b) => paintRank(a.state) - paintRank(b.state));

    columns.push({
      id: date,
      label: weekdayShort(dayWindow.start, input.timeZone),
      sublabel: date.slice(5),
      segments,
    });
  });

  const todayIndex = input.dayWindows.findIndex((dayWindow) =>
    isToday(input.now, dayWindow),
  );

  return {
    timeZone: input.timeZone,
    dates: input.dates,
    columns,
    window: windowFor(columns),
    nowMinute:
      todayIndex >= 0
        ? nowMinuteFor(
            input.now,
            input.dates[todayIndex],
            input.timeZone,
            input.dayWindows[todayIndex],
          )
        : null,
    todayIndex,
  };
}

/* ---------------------------------------------------------------------------
   Shared geometry
--------------------------------------------------------------------------- */

/**
 * The part of a span that falls inside one local day, as ribbon geometry.
 *
 * Returns the minutes AND the instants, because the segment needs both: the
 * geometry to be drawn to scale, and the real instants for its label. Null
 * when the span misses the day entirely.
 */
function clipToDay(
  span: Span,
  dayWindow: Span,
  minuteOf: (instant: string | Date) => number,
): {
  startMinute: number;
  durationMin: number;
  startsAt: string;
  endsAt: string;
} | null {
  const from = Math.max(span.start, dayWindow.start);
  const to = Math.min(span.end, dayWindow.end);

  if (to <= from) {
    return null;
  }

  const startsAt = new Date(from).toISOString();
  const endsAt = new Date(to).toISOString();

  return {
    startMinute: minuteOf(startsAt),
    durationMin: Math.round((to - from) / 60_000),
    startsAt,
    endsAt,
  };
}

/** Nothing shorter than this gets drawn — a two-hour strip is not a day. */
const MIN_WINDOW_MIN = 6 * 60;

/**
 * The slice of the day worth drawing.
 *
 * Snapped out to whole hours so the ruler starts on the clock, and widened —
 * downwards first, since an owner adding an evening appointment needs room
 * below more often than above — until it is at least six hours tall. An empty
 * Sunday falls back to a plain working day rather than collapsing to a
 * hairline, because a day with nothing in it is still a day you can drag a
 * block onto.
 */
export function windowFor(
  columns: RibbonColumn[],
  fallback = { startMinute: 8 * 60, endMinute: 20 * 60 },
): { startMinute: number; endMinute: number } {
  const segments = columns.flatMap((column) => column.segments);

  if (segments.length === 0) {
    return fallback;
  }

  const startMinute = Math.max(
    0,
    floorHour(Math.min(...segments.map((segment) => segment.startMinute))),
  );

  const contentEnd = ceilHour(
    Math.max(
      ...segments.map((segment) => segment.startMinute + segment.durationMin),
    ),
  );

  return {
    startMinute,
    endMinute: Math.max(contentEnd, startMinute + MIN_WINDOW_MIN),
  };
}

/** The now line belongs on today and nowhere else. */
function nowMinuteFor(
  now: Date,
  date: string,
  timeZone: TimeZoneId,
  dayWindow: Span,
): number | null {
  return isToday(now, dayWindow) ? localMinuteOf(now, date, timeZone) : null;
}

/**
 * Is this the day happening right now?
 *
 * Asked of the day's INSTANT WINDOW rather than by comparing date strings, so
 * it needs no timezone of its own: the window was resolved in the business's
 * zone by the loader, and "now falls inside it" is the same question with none
 * of the arithmetic.
 */
function isToday(now: Date, dayWindow: Span): boolean {
  const ms = now.getTime();

  return ms >= dayWindow.start && ms < dayWindow.end;
}

/** "Mon". Formatting an instant in a zone, which the client may also do. */
function weekdayShort(epochMs: number, timeZone: TimeZoneId): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
  }).format(new Date(epochMs));
}

/* ===========================================================================
   THE TODAY PANEL — the numbers an owner looks at in the morning
   =========================================================================== */

export interface DayGap {
  staffId: string;
  staffName: string;
  startsAt: string;
  endsAt: string;
  minutes: number;
}

export interface DaySummary {
  /** Appointments that still occupy time. Holds are counted separately. */
  bookedCount: number;
  heldCount: number;
  /**
   * What the day is worth if everybody turns up, in integer cents.
   *
   * Confirmed and completed only. A no-show is time the business lost and
   * money it did not take, and counting it would make the morning number
   * flatter and less useful than the truth.
   */
  expectedRevenueCents: number;
  /** Of that, what has already been charged as a deposit. */
  depositsTakenCents: number;
  /** The next appointment that has not started, or null. */
  next: AgendaAppointment | null;
  /** Rostered, unbooked stretches of 30 minutes or more, still ahead. */
  gaps: DayGap[];
}

/**
 * The morning read of a day.
 *
 * `now` is injected, and it does more here than set a now line: a gap that has
 * already passed is not a gap, it is a fact about lunchtime, and an owner
 * scanning for "what could I still fill" does not want yesterday's holes in the
 * list. Gaps are clipped to start at `now` for the same reason — twenty minutes
 * of a forty-minute hole are already gone.
 */
export function summariseDay(input: {
  staff: AgendaStaff[];
  openByStaff: Map<string, Span[]>;
  appointments: AgendaAppointment[];
  closures: AgendaClosure[];
  dayWindow: Span;
  now: Date;
}): DaySummary {
  const nowMs = input.now.getTime();
  const live = input.appointments.filter(occupiesTime);

  const booked = live.filter((appointment) => appointment.status !== "held");
  const held = live.filter((appointment) => appointment.status === "held");

  const earning = booked.filter(
    (appointment) =>
      appointment.status === "confirmed" || appointment.status === "completed",
  );

  const upcoming = booked
    .filter((appointment) => Date.parse(appointment.startsAt) >= nowMs)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));

  const gaps: DayGap[] = [];

  for (const member of input.staff) {
    const rostered = clipSpans(
      mergeSpans(input.openByStaff.get(member.id) ?? []),
      input.dayWindow,
    );

    const cuts: Span[] = [
      ...live
        .filter((appointment) => appointment.staffId === member.id)
        .map((appointment) => ({
          start: Date.parse(appointment.slotStartsAt),
          end: Date.parse(appointment.slotEndsAt),
        })),
      ...input.closures
        .filter(
          (closure) => closure.staffId === null || closure.staffId === member.id,
        )
        .map((closure) => ({
          start: Date.parse(closure.startsAt),
          end: Date.parse(closure.endsAt),
        })),
      /* Everything before now, cut away as though it were booked. What is left
         is only what can still be sold. */
      { start: input.dayWindow.start, end: Math.max(nowMs, input.dayWindow.start) },
    ];

    for (const span of subtractSpans(rostered, cuts)) {
      const minutes = Math.round((span.end - span.start) / 60_000);

      if (minutes >= GAP_THRESHOLD_MIN) {
        gaps.push({
          staffId: member.id,
          staffName: member.name,
          startsAt: new Date(span.start).toISOString(),
          endsAt: new Date(span.end).toISOString(),
          minutes,
        });
      }
    }
  }

  gaps.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));

  return {
    bookedCount: booked.length,
    heldCount: held.length,
    expectedRevenueCents: earning.reduce(
      (total, appointment) => total + appointment.priceCents,
      0,
    ),
    depositsTakenCents: earning.reduce(
      (total, appointment) => total + appointment.depositCents,
      0,
    ),
    next: upcoming[0] ?? null,
    gaps,
  };
}
