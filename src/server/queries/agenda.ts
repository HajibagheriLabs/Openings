import "server-only";

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appointments,
  availabilityRules,
  customers,
  services,
  serviceStaff,
  staff,
  timeOff,
  type Business,
} from "@/db/schema";
import type {
  AppointmentDetail,
  CalendarParams,
  CalendarServiceOption,
  CalendarStaffOption,
  CalendarView,
} from "@/lib/admin/calendar";
import { isCalendarView, LOCAL_DATE_PATTERN } from "@/lib/admin/calendar";
import { initialsFrom } from "@/lib/initials";
import {
  buildAgendaDay,
  buildAgendaWeek,
  occupiesTime,
  summariseDay,
  type AgendaAppointment,
  type AgendaClosure,
  type AgendaDay,
  type AgendaStaff,
  type AgendaWeek,
  type DaySummary,
} from "@/lib/scheduling/agenda";
import {
  expandRules,
  localDayWindow,
  type RuleRow,
  type Span,
} from "@/lib/scheduling/availability";
import { localDateOf } from "@/lib/scheduling/local-minutes";
import { toTstzRangeLiteral } from "@/lib/scheduling/slot";
import { Temporal, type TimeZoneId } from "@/lib/scheduling/temporal";

/**
 * Everything the master schedule reads.
 *
 * FOUR QUERIES, WHATEVER THE RANGE. A week costs exactly what a day does: the
 * roster, the rules, the closures and the appointments are each fetched once
 * for the whole window and every per-day decision happens in memory afterwards
 * (src/lib/scheduling/agenda.ts). The obvious implementation — loop the seven
 * days, query each — is seven times the round trips for the same answer, and on
 * a screen an owner leaves open all day that is the difference between a
 * calendar and a spinner.
 *
 * The shaping is deliberately somewhere else. This module knows about Postgres
 * and nothing about pixels; the module it hands rows to knows about pixels and
 * nothing about Postgres.
 */

/* ===========================================================================
   Reading the URL
   =========================================================================== */

/**
 * What the calendar should show, from the query string and the business's own
 * clock.
 *
 * "TODAY" IS THE BUSINESS'S TODAY. A shop in Auckland must not open its
 * calendar on yesterday because the server runs on UTC, and an owner in Los
 * Angeles must not see tomorrow at four in the afternoon. Every default here
 * resolves through the business timezone, and a date in the URL that is not a
 * date is discarded rather than argued with.
 */
export function resolveCalendarParams(
  business: Pick<Business, "timezone">,
  search: { view?: string; date?: string; staff?: string },
  now: Date = new Date(),
): CalendarParams {
  const view: CalendarView = isCalendarView(search.view) ? search.view : "day";

  const today = localDateOf(now, business.timezone);
  const date =
    search.date && LOCAL_DATE_PATTERN.test(search.date) && isRealDate(search.date)
      ? search.date
      : today;

  return { view, date, staffId: uuidOrNull(search.staff) };
}

/**
 * A query parameter that is going into a `uuid` column, or nothing.
 *
 * NOT DECORATION. Postgres raises `invalid input syntax for type uuid` on
 * anything that is not one, and a raised error inside a Server Component is a
 * 500 — so `?staff=nonsense` in a URL somebody pasted would take the calendar
 * down rather than showing it unfiltered. A parameter that cannot name a row
 * is treated as absent, which is the only reading that is both safe and true.
 */
export function uuidOrNull(value: string | undefined): string | null {
  return value && UUID_PATTERN.test(value) ? value : null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A well-formed string is not the same as a day that exists. */
function isRealDate(value: string): boolean {
  try {
    Temporal.PlainDate.from(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The seven local dates of the week containing `date`, Monday first.
 *
 * `dayOfWeek` is 1–7 with Monday as 1, so subtracting `dayOfWeek - 1` days
 * lands on that week's Monday. Calendar arithmetic, not a millisecond
 * subtraction that a DST change would knock sideways by an hour.
 */
export function weekDatesOf(date: string): string[] {
  const day = Temporal.PlainDate.from(date);
  const monday = day.subtract({ days: day.dayOfWeek - 1 });

  return Array.from({ length: 7 }, (_, offset) =>
    monday.add({ days: offset }).toString(),
  );
}

/** Step a local date by whole calendar days. Never by 86 400 000 milliseconds. */
export function shiftLocalDate(date: string, days: number): string {
  return Temporal.PlainDate.from(date).add({ days }).toString();
}

/** The instant window of one local day, `[startOfDay, startOfNextDay)`. */
export function dayWindowOf(date: string, timeZone: TimeZoneId): Span {
  return localDayWindow(date, date, timeZone);
}

/* ===========================================================================
   The load
   =========================================================================== */

export interface AgendaSource {
  staff: AgendaStaff[];
  openByStaff: Map<string, Span[]>;
  appointments: AgendaAppointment[];
  closures: AgendaClosure[];
}

/**
 * Every row the agenda draws, for one inclusive range of local days.
 *
 * `staffId` narrows the lanes but NOT the closures: a business-wide holiday
 * still shuts the one person being looked at, and hiding it because the filter
 * named somebody would draw them as available on Christmas Day.
 */
export async function loadAgendaSource(
  businessId: string,
  timeZone: TimeZoneId,
  from: string,
  to: string,
  options: { staffId?: string | null; now?: Date } = {},
): Promise<AgendaSource> {
  const now = options.now ?? new Date();

  /**
   * Widened by a day at each end FOR THE QUERIES ONLY.
   *
   * A shift that started last night, or an appointment whose buffer reaches
   * back across midnight, has to be fetched or it cannot be drawn or
   * subtracted. The shaping clips everything back to the days being shown.
   */
  const fetchWindow = localDayWindow(
    shiftLocalDate(from, -1),
    shiftLocalDate(to, 1),
    timeZone,
  );

  const fetchRange = toTstzRangeLiteral(
    new Date(fetchWindow.start),
    new Date(fetchWindow.end),
  );

  /* Query 1 — the roster.

     ACTIVE STAFF, PLUS ANYONE WITH AN APPOINTMENT IN THE WINDOW. The design
     says one column per active staff member, and that is right for the ordinary
     case — but deactivating somebody does not cancel the appointments already
     in their diary, and a column that vanished would hide real customers who
     are still turning up on Thursday. So the roster is drawn from both, and the
     second group is labelled. */
  const roster = await db
    .select({
      id: staff.id,
      name: staff.name,
      initials: staff.initials,
      isActive: staff.isActive,
    })
    .from(staff)
    .where(eq(staff.businessId, businessId))
    .orderBy(asc(staff.displayOrder), asc(staff.name));

  const rosterIds = roster.map((member) => member.id);

  if (rosterIds.length === 0) {
    return {
      staff: [],
      openByStaff: new Map(),
      appointments: [],
      closures: [],
    };
  }

  const [rules, closureRows, appointmentRows] = await Promise.all([
    /* Query 2 — every weekly rule that could apply anywhere in the range. The
       effective-date filter runs in SQL, so ten years of superseded hours cost
       nothing to have. */
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
          inArray(availabilityRules.staffId, rosterIds),
          sql`${availabilityRules.effectiveFrom} <= ${to}::date`,
          or(
            isNull(availabilityRules.effectiveTo),
            sql`${availabilityRules.effectiveTo} >= ${from}::date`,
          ),
        ),
      ),

    /* Query 3 — closures overlapping the window, personal and business-wide. */
    db
      .select({
        id: timeOff.id,
        staffId: timeOff.staffId,
        reason: timeOff.reason,
        startsAt: sql<string>`lower(${timeOff.range})`,
        endsAt: sql<string>`upper(${timeOff.range})`,
      })
      .from(timeOff)
      .where(
        and(
          eq(timeOff.businessId, businessId),
          sql`${timeOff.range} && ${fetchRange}::tstzrange`,
        ),
      ),

    /* Query 4 — the diary.

       Matched on the stored `slot` rather than on `starts_at`, so an
       appointment whose buffer reaches into the window is fetched even when the
       appointment itself begins outside it. Cancelled rows are fetched too —
       they are excluded from the drawing by `occupiesTime`, but the Today panel
       and the stream both need to know one exists. */
    db
      .select({
        id: appointments.id,
        staffId: appointments.staffId,
        status: appointments.status,
        startsAt: appointments.startsAt,
        endsAt: appointments.endsAt,
        slotStartsAt: sql<string>`lower(${appointments.slot})`,
        slotEndsAt: sql<string>`upper(${appointments.slot})`,
        holdExpiresAt: appointments.holdExpiresAt,
        priceCents: appointments.priceCents,
        depositCents: appointments.depositCents,
        serviceName: services.name,
        customerName: customers.name,
      })
      .from(appointments)
      .innerJoin(services, eq(services.id, appointments.serviceId))
      .leftJoin(customers, eq(customers.id, appointments.customerId))
      .where(
        and(
          eq(appointments.businessId, businessId),
          sql`${appointments.slot} && ${fetchRange}::tstzrange`,
        ),
      )
      .orderBy(asc(appointments.startsAt)),
  ]);

  const nowMs = now.getTime();

  const loaded: AgendaAppointment[] = appointmentRows.map((row) => ({
    id: row.id,
    staffId: row.staffId,
    status: row.status,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    slotStartsAt: new Date(row.slotStartsAt).toISOString(),
    slotEndsAt: new Date(row.slotEndsAt).toISOString(),
    serviceName: row.serviceName,
    customerName: row.customerName,
    customerInitials: row.customerName ? initialsFrom(row.customerName) : null,
    priceCents: row.priceCents,
    depositCents: row.depositCents,
    /* An expired hold blocks nothing — the availability query ignores it and
       the next booking transaction sweeps it — so it must not be drawn as
       though it occupied the slot. Decided here, once, against one clock. */
    isLiveHold:
      row.status === "held" &&
      row.holdExpiresAt !== null &&
      row.holdExpiresAt.getTime() > nowMs,
  }));

  const withAppointments = new Set(
    loaded.filter(occupiesTime).map((appointment) => appointment.staffId),
  );

  const lanes = roster.filter(
    (member) => member.isActive || withAppointments.has(member.id),
  );

  const visible = options.staffId
    ? lanes.filter((member) => member.id === options.staffId)
    : lanes;

  return {
    staff: visible.map((member) => ({
      id: member.id,
      name: member.name,
      /* An inactive member with a diary still to work through says so, because
         "why is Sam still on my calendar" is otherwise a support question. */
      initials: member.isActive
        ? member.initials
        : `${member.initials} · no longer bookable`,
    })),
    openByStaff: expandRules(rules as RuleRow[], { from, to, timeZone }),
    appointments: options.staffId
      ? loaded.filter((appointment) => appointment.staffId === options.staffId)
      : loaded,
    closures: closureRows.map((row) => ({
      id: row.id,
      staffId: row.staffId,
      startsAt: new Date(row.startsAt).toISOString(),
      endsAt: new Date(row.endsAt).toISOString(),
      reason: row.reason,
    })),
  };
}

/* ===========================================================================
   The two views
   =========================================================================== */

export interface AgendaDayResult {
  day: AgendaDay;
  summary: DaySummary;
  /** The day's appointments in start order, for the Today panel's list. */
  appointments: AgendaAppointment[];
  /** Every lane on the calendar, filter or no filter — the picker needs them. */
  staff: AgendaStaff[];
}

/** One local day, one column per staff member. */
export async function loadAgendaDay(
  businessId: string,
  timeZone: TimeZoneId,
  date: string,
  options: { staffId?: string | null; now?: Date } = {},
): Promise<AgendaDayResult> {
  const now = options.now ?? new Date();
  const source = await loadAgendaSource(businessId, timeZone, date, date, {
    ...options,
    now,
  });

  const dayWindow = dayWindowOf(date, timeZone);

  /* Only what actually lands on this day. The source is deliberately a day
     wider at each end so a midnight-crossing shift can be drawn; the panel's
     list and the summary are about the day itself. */
  const onThisDay = source.appointments.filter(
    (appointment) =>
      Date.parse(appointment.slotEndsAt) > dayWindow.start &&
      Date.parse(appointment.slotStartsAt) < dayWindow.end,
  );

  return {
    day: buildAgendaDay({
      date,
      timeZone,
      staff: source.staff,
      openByStaff: source.openByStaff,
      appointments: source.appointments,
      closures: source.closures,
      dayWindow,
      now,
    }),
    summary: summariseDay({
      staff: source.staff,
      openByStaff: source.openByStaff,
      appointments: onThisDay,
      closures: source.closures,
      dayWindow,
      now,
    }),
    appointments: onThisDay,
    staff: source.staff,
  };
}

export interface AgendaWeekResult {
  week: AgendaWeek;
  staff: AgendaStaff[];
  /** Per-day counts, for the column headings. */
  countsByDate: Record<string, number>;
}

/** Seven compressed day columns, Monday first. */
export async function loadAgendaWeek(
  businessId: string,
  timeZone: TimeZoneId,
  date: string,
  options: { staffId?: string | null; now?: Date } = {},
): Promise<AgendaWeekResult> {
  const now = options.now ?? new Date();
  const dates = weekDatesOf(date);

  const source = await loadAgendaSource(
    businessId,
    timeZone,
    dates[0],
    dates[6],
    { ...options, now },
  );

  const dayWindows = dates.map((day) => dayWindowOf(day, timeZone));

  const countsByDate: Record<string, number> = {};

  dates.forEach((day, index) => {
    const dayWindow = dayWindows[index];

    countsByDate[day] = source.appointments.filter(
      (appointment) =>
        occupiesTime(appointment) &&
        Date.parse(appointment.startsAt) >= dayWindow.start &&
        Date.parse(appointment.startsAt) < dayWindow.end,
    ).length;
  });

  return {
    week: buildAgendaWeek({
      dates,
      timeZone,
      staff: source.staff,
      openByStaff: source.openByStaff,
      appointments: source.appointments,
      closures: source.closures,
      dayWindows,
      now,
      singleStaff: Boolean(options.staffId) || source.staff.length === 1,
    }),
    staff: source.staff,
    countsByDate,
  };
}

/* ===========================================================================
   The detail sheet
   =========================================================================== */

/**
 * One appointment, in full, scoped to the business that owns it.
 *
 * The business id is part of the WHERE clause rather than checked afterwards,
 * so an id from another tenant returns null instead of somebody else's
 * customer's phone number.
 */
export async function loadAppointmentDetail(
  businessId: string,
  appointmentId: string,
): Promise<AppointmentDetail | null> {
  const [row] = await db
    .select({
      id: appointments.id,
      status: appointments.status,
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      priceCents: appointments.priceCents,
      depositCents: appointments.depositCents,
      paymentIntentId: appointments.stripePaymentIntentId,
      checkoutSessionId: appointments.stripeCheckoutSessionId,
      refundedCents: appointments.refundedCents,
      customerNote: appointments.customerNote,
      internalNote: appointments.internalNote,
      cancelledBy: appointments.cancelledBy,
      cancellationReason: appointments.cancellationReason,
      serviceName: services.name,
      staffName: staff.name,
      customerId: customers.id,
      customerName: customers.name,
      customerEmail: customers.email,
      customerPhone: customers.phone,
    })
    .from(appointments)
    .innerJoin(services, eq(services.id, appointments.serviceId))
    .innerJoin(staff, eq(staff.id, appointments.staffId))
    .leftJoin(customers, eq(customers.id, appointments.customerId))
    .where(
      and(
        eq(appointments.id, appointmentId),
        eq(appointments.businessId, businessId),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    status: row.status,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    serviceName: row.serviceName,
    staffName: row.staffName,
    priceCents: row.priceCents,
    depositCents: row.depositCents,
    /* A payment intent is the only proof money moved. A checkout session that
       was created and never paid is not, which is exactly the distinction the
       webhook exists to police. */
    depositPaid: Boolean(row.paymentIntentId),
    refundedCents: row.refundedCents,
    customer:
      row.customerId && row.customerName && row.customerEmail
        ? {
            id: row.customerId,
            name: row.customerName,
            email: row.customerEmail,
            phone: row.customerPhone,
          }
        : null,
    customerNote: row.customerNote,
    internalNote: row.internalNote,
    /* No Stripe session ever existed, so nobody was ever sent to a payment
       page: the owner typed this one in. Derived rather than stored — a column
       would be a second copy of a fact the payment trail already carries. */
    createdByOwner: row.checkoutSessionId === null && row.status !== "held",
    cancelledBy: row.cancelledBy,
    cancellationReason: row.cancellationReason,
  };
}

/* ===========================================================================
   The manual-booking form's options
   =========================================================================== */

export interface CalendarOptions {
  staff: CalendarStaffOption[];
  services: CalendarServiceOption[];
}

/** Active staff and active services, with the assignment between them. */
export async function loadCalendarOptions(
  businessId: string,
): Promise<CalendarOptions> {
  const [team, catalogue, assignments] = await Promise.all([
    db
      .select({
        id: staff.id,
        name: staff.name,
        initials: staff.initials,
      })
      .from(staff)
      .where(and(eq(staff.businessId, businessId), eq(staff.isActive, true)))
      .orderBy(asc(staff.displayOrder), asc(staff.name)),

    db
      .select({
        id: services.id,
        name: services.name,
        durationMin: services.durationMin,
        priceCents: services.priceCents,
      })
      .from(services)
      .where(
        and(eq(services.businessId, businessId), eq(services.isActive, true)),
      )
      .orderBy(asc(services.displayOrder), asc(services.name)),

    db
      .select({
        serviceId: serviceStaff.serviceId,
        staffId: serviceStaff.staffId,
      })
      .from(serviceStaff)
      .innerJoin(services, eq(services.id, serviceStaff.serviceId))
      .where(eq(services.businessId, businessId)),
  ]);

  const byService = new Map<string, string[]>();

  for (const link of assignments) {
    byService.set(link.serviceId, [
      ...(byService.get(link.serviceId) ?? []),
      link.staffId,
    ]);
  }

  return {
    staff: team,
    services: catalogue.map((service) => ({
      ...service,
      staffIds: byService.get(service.id) ?? [],
    })),
  };
}

/* ===========================================================================
   "Show me the appointments that are stopping this delete"
   =========================================================================== */

export interface ServiceFocus {
  name: string;
  upcomingCount: number;
  /** Local date of the earliest one still to come, or null. */
  firstDate: string | null;
}

/**
 * What `/admin/calendar?service=<id>` is really asking.
 *
 * The services screen refuses a delete by pointing here — "N appointments
 * still to come, show them" — and a link that landed on an unchanged calendar
 * would make that refusal look like a dead end.
 *
 * IT IS NOT A FILTER, AND THAT IS DELIBERATE. Hiding every other appointment
 * would draw their time as open, which is the one thing this screen must never
 * do: an owner glancing at a filtered calendar would see a free afternoon that
 * is fully booked. So the calendar stays whole and this answers the question
 * beside it — how many, and where the first one is — with a link to that day.
 */
export async function loadServiceFocus(
  businessId: string,
  serviceId: string,
  timeZone: TimeZoneId,
  now: Date = new Date(),
): Promise<ServiceFocus | null> {
  const [service] = await db
    .select({ name: services.name })
    .from(services)
    .where(
      and(eq(services.id, serviceId), eq(services.businessId, businessId)),
    )
    .limit(1);

  if (!service) {
    return null;
  }

  const upcoming = await db
    .select({ startsAt: appointments.startsAt })
    .from(appointments)
    .where(
      and(
        eq(appointments.businessId, businessId),
        eq(appointments.serviceId, serviceId),
        eq(appointments.status, "confirmed"),
        sql`${appointments.startsAt} >= ${now}`,
      ),
    )
    .orderBy(asc(appointments.startsAt));

  return {
    name: service.name,
    upcomingCount: upcoming.length,
    firstDate: upcoming[0]
      ? localDateOf(upcoming[0].startsAt, timeZone)
      : null,
  };
}

/* ===========================================================================
   The stream's snapshot
   =========================================================================== */

/** One row as the stream remembers it between ticks. */
export interface AgendaSnapshotRow {
  id: string;
  status: string;
  startsAt: string;
  customerName: string | null;
  staffName: string;
}

/**
 * The diary in the window, cheaply, for the live stream to diff against itself.
 *
 * DELIBERATELY NARROW. This runs every few seconds on a held-open connection,
 * so it selects the five fields a change notice can be written from and joins
 * only what those need. The agenda itself is never rendered from this — when
 * something moves, the client re-renders the Server Component and reads the
 * truth. This is a doorbell, not a data feed.
 */
export async function loadAgendaSnapshot(
  businessId: string,
  from: string,
  to: string,
  timeZone: TimeZoneId,
): Promise<AgendaSnapshotRow[]> {
  const window = localDayWindow(from, to, timeZone);
  const range = toTstzRangeLiteral(
    new Date(window.start),
    new Date(window.end),
  );

  const rows = await db
    .select({
      id: appointments.id,
      status: appointments.status,
      startsAt: appointments.startsAt,
      customerName: customers.name,
      staffName: staff.name,
    })
    .from(appointments)
    .innerJoin(staff, eq(staff.id, appointments.staffId))
    .leftJoin(customers, eq(customers.id, appointments.customerId))
    .where(
      and(
        eq(appointments.businessId, businessId),
        sql`${appointments.slot} && ${range}::tstzrange`,
      ),
    );

  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    startsAt: row.startsAt.toISOString(),
    customerName: row.customerName,
    staffName: row.staffName,
  }));
}
