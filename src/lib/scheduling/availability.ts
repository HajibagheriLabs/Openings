import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import {
  appointments,
  availabilityRules,
  businesses,
  services,
  serviceStaff,
  staff,
  timeOff,
} from "@/db/schema";

import { toTstzRangeLiteral } from "./slot";
import { Temporal, type TimeZoneId } from "./temporal";

/* ===========================================================================
   THE AVAILABILITY ALGORITHM
   ---------------------------------------------------------------------------
   Given a service, a staff member (or anyone qualified) and a range of local
   days, work out every moment a customer could start that appointment.

   THE FILE IS IN TWO HALVES, AND THE SPLIT IS THE POINT.

   `computeAvailability` is PURE. It takes data that has already been loaded
   and a clock that has already been read, and returns openings. It touches no
   database, calls no `Date.now()`, and reads no configuration — which is what
   lets the test suite pin down spring-forward, fall-back and the exact
   lead-time boundary as ordinary fast unit tests instead of fixtures that
   drift with the calendar.

   `getAvailability` is the loader. It runs five constant queries — never one
   per day — and hands the result to the pure half.

   TIME RULES, WHICH THIS MODULE EXISTS TO OBEY
   --------------------------------------------
   * Wall-clock to instant conversion happens ONLY through Temporal, in the
     business's timezone, with the disambiguation named explicitly. There is
     not one fixed hour offset anywhere in this file.
   * Stepping across time is `Instant.add({ minutes })`, which is EXACT-TIME
     arithmetic: it advances real elapsed minutes, so a slot grid crossing a
     DST boundary comes out right without anything special-casing the day.
   * Epoch milliseconds appear only for SET ALGEBRA — does this span overlap
     that one, what is left after subtracting it. That is arithmetic on the
     real line, not calendar arithmetic: no millisecond in this file is ever
     added to in order to mean "a day later" or "an hour later".
   * Nothing returns a local wall-clock string. Ever. The output is ISO
     instants plus the IANA zone, and the client formats them.
   =========================================================================== */

/* ---------------------------------------------------------------------------
   Spans — the working representation
--------------------------------------------------------------------------- */

/**
 * A half-open interval of real time, in epoch milliseconds.
 *
 * Half-open `[start, end)` like every other range in this project, so a span
 * ending where the next begins does not overlap it and back-to-back work is
 * expressible.
 *
 * Milliseconds rather than Instants purely for the set algebra below. Every
 * boundary in one of these was produced by Temporal, in the business zone; the
 * numbers are only ever compared, never used to mean a calendar quantity.
 */
export interface Span {
  start: number;
  end: number;
}

/** Total minutes across a list of spans. Used by the DST tests. */
export function spanMinutes(spans: Span[]): number {
  return spans.reduce(
    (total, span) => total + (span.end - span.start) / 60_000,
    0,
  );
}

/**
 * Sort, merge touching or overlapping spans, drop empty ones.
 *
 * Merging TOUCHING spans is not tidiness — it is what makes a midnight-
 * crossing shift continuous. A Monday 22:00–02:00 rule and a Tuesday
 * 02:00–09:00 rule are two rows that meet at one instant; merged, a service
 * can start at 01:30 and run through the seam. Left separate, the window would
 * have to fit inside one of them and the seam would become an invisible wall.
 */
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);

  const merged: Span[] = [];

  for (const span of sorted) {
    const last = merged[merged.length - 1];

    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }

  return merged;
}

/** Clip spans to a window, dropping anything wholly outside it. */
export function clipSpans(spans: Span[], window: Span): Span[] {
  const clipped: Span[] = [];

  for (const span of spans) {
    const start = Math.max(span.start, window.start);
    const end = Math.min(span.end, window.end);

    if (end > start) {
      clipped.push({ start, end });
    }
  }

  return clipped;
}

/**
 * What is left of `base` once every span in `cuts` is removed.
 *
 * Steps 2 and 3 of the algorithm are both this function: time off and busy
 * appointments are the same kind of fact — time that is not available — and
 * subtracting them with one implementation means they cannot disagree about a
 * boundary.
 */
export function subtractSpans(base: Span[], cuts: Span[]): Span[] {
  const removals = mergeSpans(cuts);
  let remaining = mergeSpans(base);

  for (const cut of removals) {
    const next: Span[] = [];

    for (const span of remaining) {
      // No overlap: the span survives untouched.
      if (cut.end <= span.start || cut.start >= span.end) {
        next.push(span);
        continue;
      }

      // The head, if the cut starts after the span does.
      if (cut.start > span.start) {
        next.push({ start: span.start, end: cut.start });
      }

      // The tail, if the cut ends before the span does.
      if (cut.end < span.end) {
        next.push({ start: cut.end, end: span.end });
      }
    }

    remaining = next;
  }

  return remaining;
}

/* ---------------------------------------------------------------------------
   Step 1 — expanding recurring rules into concrete instants
--------------------------------------------------------------------------- */

/**
 * DISAMBIGUATION, NAMED RATHER THAN DEFAULTED.
 *
 * Twice a year a wall-clock time is not a moment:
 *
 *   SPRING FORWARD — 02:30 does not exist. "compatible" resolves it forward,
 *   to 03:30. The business opens at the first moment its stated opening time
 *   could be said to have arrived, rather than throwing on one day a year.
 *
 *   FALL BACK — 02:30 happens twice. "compatible" takes the FIRST, which for
 *   an opening time is the generous reading and for a closing time is the
 *   conservative one. Both are defensible; being consistent matters more than
 *   being clever, and a rule boundary landing inside the one repeated hour is
 *   vanishingly rare.
 *
 * What this does NOT affect is the slots themselves. Those are produced by
 * exact-time stepping from the interval's start, so a wall-clock time that
 * does not exist is never offered — not because it is filtered out, but
 * because real elapsed minutes never land on it.
 */
const DISAMBIGUATION = "compatible" as const;

export interface RuleRow {
  staffId: string;
  /** 0 = Sunday … 6 = Saturday, matching Postgres `extract(dow)`. */
  weekday: number;
  /** Postgres `time`, e.g. "09:00:00". LOCAL wall-clock. Never an instant. */
  startLocal: string;
  endLocal: string;
  /** Local calendar dates bounding when the rule applies. `to` is inclusive. */
  effectiveFrom: string;
  effectiveTo: string | null;
}

/**
 * Recurring weekly rules into concrete instant spans, per staff member.
 *
 * The expansion walks LOCAL CALENDAR DAYS and converts each rule's wall-clock
 * boundaries on that day into instants. It never adds 24 hours to get to
 * tomorrow and never adds an offset to get to UTC; `PlainDate.add({ days: 1 })`
 * is calendar arithmetic and `toZonedDateTime` asks the timezone where the
 * boundary really is.
 *
 * IT STARTS A DAY EARLY. A shift that crosses midnight belongs to the weekday
 * it STARTS on, so the hours available at 01:00 on the first requested day
 * come from a rule anchored to the day before. Expanding from `from - 1` and
 * clipping afterwards is what makes the first day of a range as correct as
 * the middle of one.
 */
export function expandRules(
  rules: RuleRow[],
  options: {
    /** Inclusive local calendar dates in the business timezone. */
    from: string;
    to: string;
    timeZone: TimeZoneId;
  },
): Map<string, Span[]> {
  const { timeZone } = options;
  const fromDate = Temporal.PlainDate.from(options.from);
  const toDate = Temporal.PlainDate.from(options.to);

  const byStaff = new Map<string, Span[]>();

  // One day early, for a shift that started yesterday and is still running.
  let date = fromDate.subtract({ days: 1 });

  while (Temporal.PlainDate.compare(date, toDate) <= 0) {
    // Temporal counts Monday as 1 and Sunday as 7; the column is Sunday-zero.
    const weekday = date.dayOfWeek % 7;
    const localDate = date.toString();

    for (const rule of rules) {
      if (rule.weekday !== weekday) {
        continue;
      }

      // Effective dating, as plain string comparison — exact for ISO dates.
      if (rule.effectiveFrom > localDate) {
        continue;
      }
      if (rule.effectiveTo && rule.effectiveTo < localDate) {
        continue;
      }

      const span = ruleSpanOn(rule, date, timeZone);

      if (span) {
        byStaff.set(rule.staffId, [
          ...(byStaff.get(rule.staffId) ?? []),
          span,
        ]);
      }
    }

    date = date.add({ days: 1 });
  }

  const window = localDayWindow(options.from, options.to, timeZone);

  for (const [staffId, spans] of byStaff) {
    // Merge first, THEN clip: two rules meeting at midnight have to become one
    // span before the window trims the edges, or the seam survives as a wall.
    byStaff.set(staffId, clipSpans(mergeSpans(spans), window));
  }

  return byStaff;
}

/** One rule on one local date, as a real instant span. */
function ruleSpanOn(
  rule: RuleRow,
  date: Temporal.PlainDate,
  timeZone: TimeZoneId,
): Span | null {
  const startTime = plainTimeFrom(rule.startLocal);
  const endTime = plainTimeFrom(rule.endLocal);

  if (!startTime || !endTime) {
    return null;
  }

  const comparison = Temporal.PlainTime.compare(endTime, startTime);

  if (comparison === 0) {
    // Refused at the form boundary too. A zero-length rule is a typo, and
    // reading it as 24 hours would silently open the business all day.
    return null;
  }

  /**
   * `end_local < start_local` means the shift carries into the NEXT DAY, which
   * is what the schema documents and what the hours editor writes. The carry
   * is a calendar day, not 24 hours: on a DST day the resulting span is 23 or
   * 25 hours long, and it should be.
   */
  const endDate = comparison < 0 ? date.add({ days: 1 }) : date;

  const start = date
    .toPlainDateTime(startTime)
    .toZonedDateTime(timeZone, { disambiguation: DISAMBIGUATION });
  const end = endDate
    .toPlainDateTime(endTime)
    .toZonedDateTime(timeZone, { disambiguation: DISAMBIGUATION });

  return { start: start.epochMilliseconds, end: end.epochMilliseconds };
}

function plainTimeFrom(value: string): Temporal.PlainTime | null {
  try {
    return Temporal.PlainTime.from(value);
  } catch {
    return null;
  }
}

/**
 * The instant window covering a range of LOCAL days, end exclusive.
 *
 * Start of the first local day to the start of the day after the last one.
 * Resolved through the timezone, so it is right on the two days a local day is
 * not 24 hours long — the same reasoning as an all-day closure.
 */
export function localDayWindow(
  from: string,
  to: string,
  timeZone: TimeZoneId,
): Span {
  const start = Temporal.PlainDate.from(from)
    .toZonedDateTime(timeZone)
    .startOfDay();
  const end = Temporal.PlainDate.from(to)
    .add({ days: 1 })
    .toZonedDateTime(timeZone)
    .startOfDay();

  return { start: start.epochMilliseconds, end: end.epochMilliseconds };
}

/* ---------------------------------------------------------------------------
   Step 4 — sliding the window
--------------------------------------------------------------------------- */

export interface ServiceTiming {
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
}

/**
 * Round an instant UP onto the business's slot grid.
 *
 * The grid is the LOCAL WALL CLOCK — :00, :15, :30, :45 for a 15-minute
 * granularity — because that is what a customer expects to see and what the
 * business set. It matters most after a subtraction: an appointment ending at
 * 10:20 leaves free time from 10:20, and the next offer should be 10:30, not
 * 10:20.
 *
 * Stepping onward from here is exact-time, which keeps the grid aligned across
 * a DST change as long as the offset shift is a whole number of grid steps.
 * Every real-world shift is 30 or 60 minutes, so any granularity dividing 30
 * — every sensible one — stays aligned.
 */
export function alignUpToGrid(
  epochMs: number,
  timeZone: TimeZoneId,
  granularityMin: number,
): number {
  // Any sub-minute part rounds up first: a slot never starts at 10:20:30.
  const instant = Temporal.Instant.fromEpochMilliseconds(epochMs).round({
    smallestUnit: "minute",
    roundingMode: "ceil",
  });

  const zoned = instant.toZonedDateTimeISO(timeZone);
  const minuteOfDay = zoned.hour * 60 + zoned.minute;
  const remainder = minuteOfDay % granularityMin;

  return remainder === 0
    ? instant.epochMilliseconds
    : instant.add({ minutes: granularityMin - remainder }).epochMilliseconds;
}

/**
 * Every customer-facing start time that fits inside one free span.
 *
 * THE WINDOW IS `buffer_before + duration + buffer_after`, AND IT MUST FIT
 * ENTIRELY. A 60-minute service cannot start 30 minutes before closing, and it
 * cannot start so late that its cleanup would run past the end of the shift
 * either — the buffers are the staff member's working time, not slack that can
 * hang over the edge of the day.
 *
 * Returned instants are the CUSTOMER-FACING start: the moment the appointment
 * begins, which is `buffer_before` after the blocking window opens. That is
 * what the confirmation email says, and it is what gets stored in `starts_at`.
 */
export function slideWindow(
  span: Span,
  timing: ServiceTiming,
  timeZone: TimeZoneId,
  granularityMin: number,
): number[] {
  const beforeMs = timing.bufferBeforeMin * 60_000;
  const afterMs = timing.bufferAfterMin * 60_000;
  const durationMs = timing.durationMin * 60_000;

  // The earliest the appointment itself could begin: the span opens, then the
  // before-buffer runs, then the customer arrives.
  const earliest = span.start + beforeMs;

  let current = Temporal.Instant.fromEpochMilliseconds(
    alignUpToGrid(earliest, timeZone, granularityMin),
  );

  const starts: number[] = [];

  // Exact-time stepping. Never `+= granularity * 60000` as a calendar step —
  // this advances real elapsed minutes, which is precisely why a grid crossing
  // a spring-forward gap skips the hour that does not exist.
  while (current.epochMilliseconds + durationMs + afterMs <= span.end) {
    starts.push(current.epochMilliseconds);
    current = current.add({ minutes: granularityMin });
  }

  return starts;
}

/* ---------------------------------------------------------------------------
   The pure engine
--------------------------------------------------------------------------- */

export interface AvailabilityStaff {
  id: string;
  name: string;
  initials: string;
}

/** A closure. `staffId: null` closes the whole business. */
export interface TimeOffRow {
  staffId: string | null;
  startsAt: Date;
  endsAt: Date;
}

/**
 * Time already taken, from `appointments.slot`.
 *
 * THESE BOUNDS ARE THE STORED BLOCKING RANGE, buffers included. Nothing here
 * re-derives them from `starts_at` and the service's buffers, because that
 * calculation already happened when the appointment was written — and the
 * buffers in force then may differ from the buffers configured now. The stored
 * range is the fact; the service row is a template for new ones.
 */
export interface BlockedRow {
  staffId: string;
  startsAt: Date;
  endsAt: Date;
}

export interface AvailabilityContext {
  timeZone: TimeZoneId;
  slotGranularityMin: number;
  minLeadTimeMin: number;
  maxAdvanceDays: number;
  service: ServiceTiming & { id: string; isActive: boolean };
  /** Qualified and active. The loader filters; the engine trusts. */
  staff: AvailabilityStaff[];
  rules: RuleRow[];
  timeOff: TimeOffRow[];
  blocked: BlockedRow[];
}

export interface AvailabilityWindow {
  /** Inclusive LOCAL calendar dates in the business timezone, "2026-03-29". */
  from: string;
  to: string;
  /** The clock, injected. Never read from inside — see the note on the file. */
  now: Date;
}

export interface AvailabilitySlot {
  /** ISO instant. The customer-facing start. */
  startsAt: string;
  /** ISO instant. `startsAt` plus the service duration, buffers excluded. */
  endsAt: string;
  /**
   * Everyone free at this instant, in the order the loader supplied them.
   *
   * For a specific staff request this is always one id. For `'any'` it is the
   * union, which is what lets the booking flow auto-assign the first or offer
   * the choice — without a second round of queries to find out who is free.
   */
  staffIds: string[];
}

export interface AvailabilityResult {
  /** IANA identifier. The client formats the instants above with this. */
  timeZone: TimeZoneId;
  serviceId: string;
  /** Customer-facing length. */
  durationMin: number;
  /** What the calendar actually loses, buffers included. */
  blockedMin: number;
  /** Ascending by instant. */
  slots: AvailabilitySlot[];
  /**
   * The policy that was actually applied, so a caller can explain an empty
   * list — "nothing today, the next booking has to be two hours out" — rather
   * than showing a blank calendar with no reason.
   */
  policy: {
    slotGranularityMin: number;
    minLeadTimeMin: number;
    maxAdvanceDays: number;
    /** ISO instant: nothing may start before this. */
    earliestStart: string;
    /** ISO instant, exclusive: nothing may start at or after this. */
    latestStart: string;
  };
}

/**
 * Steps 1 to 6, on data that is already in memory.
 *
 * Pure: same inputs, same output, every time, on any machine, in any server
 * timezone. `now` arrives as an argument precisely so this stays true — the
 * lead-time boundary and the expiry of a hold are both decided against it.
 */
export function computeAvailability(
  context: AvailabilityContext,
  window: AvailabilityWindow,
): AvailabilityResult {
  const { timeZone, service } = context;

  const blockedMin =
    service.bufferBeforeMin + service.durationMin + service.bufferAfterMin;

  /* Step 5, applied first where it is cheapest: the bounds of what may be
     offered at all. Computing them up front also means they can be reported
     back even when the slot list comes out empty. */
  const earliestStart = Temporal.Instant.fromEpochMilliseconds(now(window))
    .add({ minutes: context.minLeadTimeMin })
    .epochMilliseconds;

  const today = Temporal.Instant.fromEpochMilliseconds(now(window))
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();

  /**
   * The horizon, as a LOCAL DAY BOUNDARY rather than "now plus N times 24
   * hours". `max_advance_days` is a number of calendar days the customer can
   * see, so the last bookable day is today + N, inclusive, and the bound is
   * the start of the day after that.
   */
  const latestStart = today
    .add({ days: context.maxAdvanceDays + 1 })
    .toZonedDateTime(timeZone)
    .startOfDay().epochMilliseconds;

  const policy: AvailabilityResult["policy"] = {
    slotGranularityMin: context.slotGranularityMin,
    minLeadTimeMin: context.minLeadTimeMin,
    maxAdvanceDays: context.maxAdvanceDays,
    earliestStart: new Date(earliestStart).toISOString(),
    latestStart: new Date(latestStart).toISOString(),
  };

  const empty: AvailabilityResult = {
    timeZone,
    serviceId: service.id,
    durationMin: service.durationMin,
    blockedMin,
    slots: [],
    policy,
  };

  // An inactive service is not bookable, whatever its hours say. The admin
  // flags this; here it simply produces nothing.
  if (!service.isActive || context.staff.length === 0) {
    return empty;
  }

  /* Step 1 — expand the weekly rules, per staff member. */
  const openByStaff = expandRules(context.rules, {
    from: window.from,
    to: window.to,
    timeZone,
  });

  /* Steps 2 and 3 — subtract closures and busy time, then step 4 — slide. */
  const startsToStaff = new Map<number, string[]>();

  for (const member of context.staff) {
    const open = openByStaff.get(member.id) ?? [];

    if (open.length === 0) {
      continue;
    }

    const cuts: Span[] = [];

    // Step 2. A business-wide closure (staff_id IS NULL) removes time from
    // everyone, which is a different fact from every individual being off.
    for (const closure of context.timeOff) {
      if (closure.staffId === null || closure.staffId === member.id) {
        cuts.push({
          start: closure.startsAt.getTime(),
          end: closure.endsAt.getTime(),
        });
      }
    }

    // Step 3. The stored blocking range, buffers already inside it.
    for (const busy of context.blocked) {
      if (busy.staffId === member.id) {
        cuts.push({
          start: busy.startsAt.getTime(),
          end: busy.endsAt.getTime(),
        });
      }
    }

    const free = subtractSpans(open, cuts);

    /* Step 4. */
    for (const span of free) {
      for (const start of slideWindow(
        span,
        service,
        timeZone,
        context.slotGranularityMin,
      )) {
        /* Step 5, per slot. */
        if (start < earliestStart || start >= latestStart) {
          continue;
        }

        startsToStaff.set(start, [
          ...(startsToStaff.get(start) ?? []),
          member.id,
        ]);
      }
    }
  }

  /* Step 6 — one entry per instant, carrying everyone free at it. */
  const slots: AvailabilitySlot[] = [...startsToStaff.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, staffIds]) => ({
      startsAt: new Date(start).toISOString(),
      endsAt: Temporal.Instant.fromEpochMilliseconds(start)
        .add({ minutes: service.durationMin })
        .toString(),
      staffIds,
    }));

  return { ...empty, slots };
}

/** The injected clock, in one place so it is obvious there is only one. */
function now(window: AvailabilityWindow): number {
  return window.now.getTime();
}

/* ---------------------------------------------------------------------------
   The loader
--------------------------------------------------------------------------- */

export interface AvailabilityRequest {
  /**
   * The Drizzle handle, injected rather than imported.
   *
   * `src/db/index.ts` builds its pool from validated configuration at import
   * time, so importing it here would make this module — and everything that
   * imports it, including the pure engine above — require a full environment
   * just to be loaded. Passing the handle keeps the algorithm testable with
   * nothing but Node.
   */
  db: Db;
  businessId: string;
  serviceId: string;
  /** A specific person, or anyone qualified. */
  staffId: string | "any";
  /** Inclusive LOCAL calendar dates in the business timezone, "2026-03-29". */
  from: string;
  to: string;
  /** Injected clock. Defaults to the real one; tests always pass their own. */
  now?: Date;
}

/**
 * Load and compute.
 *
 * FIVE QUERIES, REGARDLESS OF HOW MANY DAYS ARE ASKED FOR. A month of
 * availability costs exactly what a day does, because the rules, the closures
 * and the appointments are each fetched once for the whole range and every
 * per-day decision happens in memory afterwards. The obvious implementation —
 * loop the days, query each one — is thirty times the round trips for the same
 * answer, and it is the reason booking pages feel slow.
 *
 * Returns null when the service does not exist or does not belong to that
 * business, which is the same answer either way: from outside, a service you
 * cannot see is indistinguishable from one that was never created.
 */
export async function getAvailability(
  request: AvailabilityRequest,
): Promise<AvailabilityResult | null> {
  const { db, businessId, serviceId, staffId } = request;
  const clock = request.now ?? new Date();

  /* Query 1 — the service and the business it belongs to, in one row. The
     join is also the ownership check: a service id from another tenant
     matches nothing. */
  const [found] = await db
    .select({
      timeZone: businesses.timezone,
      slotGranularityMin: businesses.slotGranularityMin,
      minLeadTimeMin: businesses.minLeadTimeMin,
      maxAdvanceDays: businesses.maxAdvanceDays,
      serviceId: services.id,
      durationMin: services.durationMin,
      bufferBeforeMin: services.bufferBeforeMin,
      bufferAfterMin: services.bufferAfterMin,
      isActive: services.isActive,
    })
    .from(services)
    .innerJoin(businesses, eq(businesses.id, services.businessId))
    .where(
      and(eq(services.id, serviceId), eq(services.businessId, businessId)),
    )
    .limit(1);

  if (!found) {
    return null;
  }

  const timeZone = found.timeZone;

  /**
   * The instant window, resolved in the business's zone.
   *
   * Widened by a day at each end for the QUERIES only. A shift that starts the
   * evening before, or an appointment whose buffer reaches back across
   * midnight, has to be fetched or it cannot be subtracted; the engine clips
   * the answer back to the requested days.
   */
  const fetchWindow = localDayWindow(
    Temporal.PlainDate.from(request.from).subtract({ days: 1 }).toString(),
    Temporal.PlainDate.from(request.to).add({ days: 1 }).toString(),
    timeZone,
  );

  const fetchRange = toTstzRangeLiteral(
    new Date(fetchWindow.start),
    new Date(fetchWindow.end),
  );

  /* Query 2 — who is qualified, active, and (if asked for) the one person. */
  const qualified = await db
    .select({
      id: staff.id,
      name: staff.name,
      initials: staff.initials,
    })
    .from(serviceStaff)
    .innerJoin(staff, eq(staff.id, serviceStaff.staffId))
    .where(
      and(
        eq(serviceStaff.serviceId, serviceId),
        eq(staff.businessId, businessId),
        // Step 5: a deactivated staff member is offered to nobody.
        eq(staff.isActive, true),
        staffId === "any" ? undefined : eq(staff.id, staffId),
      ),
    );

  const staffIds = qualified.map((member) => member.id);

  const context: AvailabilityContext = {
    timeZone,
    slotGranularityMin: found.slotGranularityMin,
    minLeadTimeMin: found.minLeadTimeMin,
    maxAdvanceDays: found.maxAdvanceDays,
    service: {
      id: found.serviceId,
      durationMin: found.durationMin,
      bufferBeforeMin: found.bufferBeforeMin,
      bufferAfterMin: found.bufferAfterMin,
      isActive: found.isActive,
    },
    staff: qualified,
    rules: [],
    timeOff: [],
    blocked: [],
  };

  // Nobody qualified means no queries worth running.
  if (staffIds.length === 0) {
    return computeAvailability(context, {
      from: request.from,
      to: request.to,
      now: clock,
    });
  }

  const [rules, closures, busy] = await Promise.all([
    /* Query 3 — every rule that could apply anywhere in the range. The
       effective-date filter is inclusive at both ends and runs in SQL, so a
       staff member with ten years of superseded hours fetches only the
       versions that overlap the window. */
    db
      .select({
        staffId: availabilityRules.staffId,
        weekday: availabilityRules.weekday,
        startLocal: availabilityRules.startLocal,
        endLocal: availabilityRules.endLocal,
        effectiveFrom: availabilityRules.effectiveFrom,
        effectiveTo: availabilityRules.effectiveTo,
      })
      .from(availabilityRules)
      .where(
        and(
          inArray(availabilityRules.staffId, staffIds),
          sql`${availabilityRules.effectiveFrom} <= ${request.to}::date`,
          or(
            isNull(availabilityRules.effectiveTo),
            sql`${availabilityRules.effectiveTo} >= ${request.from}::date`,
          ),
        ),
      ),

    /* Query 4 — closures overlapping the window: this staff member's own, and
       the business-wide ones that apply to everybody. */
    db
      .select({
        staffId: timeOff.staffId,
        startsAt: sql<string>`lower(${timeOff.range})`,
        endsAt: sql<string>`upper(${timeOff.range})`,
      })
      .from(timeOff)
      .where(
        and(
          eq(timeOff.businessId, businessId),
          sql`${timeOff.range} && ${fetchRange}::tstzrange`,
          or(isNull(timeOff.staffId), inArray(timeOff.staffId, staffIds)),
        ),
      ),

    /* Query 5 — time already taken.
       `slot`, not `starts_at`/`ends_at`: the stored range already contains the
       buffers that were in force when the appointment was made.
       The hold cutoff is the INJECTED clock rather than Postgres `now()`, so
       the whole computation is deterministic — an expired hold blocks nothing,
       and which holds are expired is decided by one clock, not two. */
    db
      .select({
        staffId: appointments.staffId,
        startsAt: sql<string>`lower(${appointments.slot})`,
        endsAt: sql<string>`upper(${appointments.slot})`,
      })
      .from(appointments)
      .where(
        and(
          inArray(appointments.staffId, staffIds),
          sql`${appointments.slot} && ${fetchRange}::tstzrange`,
          or(
            eq(appointments.status, "confirmed"),
            and(
              eq(appointments.status, "held"),
              sql`${appointments.holdExpiresAt} > ${clock}`,
            ),
          ),
        ),
      ),
  ]);

  context.rules = rules;
  context.timeOff = closures.map((row) => ({
    staffId: row.staffId,
    startsAt: new Date(row.startsAt),
    endsAt: new Date(row.endsAt),
  }));
  context.blocked = busy.map((row) => ({
    staffId: row.staffId,
    startsAt: new Date(row.startsAt),
    endsAt: new Date(row.endsAt),
  }));

  return computeAvailability(context, {
    from: request.from,
    to: request.to,
    now: clock,
  });
}
