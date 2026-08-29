import type { Metadata } from "next";
import Link from "next/link";

import { CalendarWorkspace } from "@/components/admin/calendar/calendar-workspace";
import { PageHeader } from "@/components/page-header";
import type { RibbonColumn } from "@/components/ribbon";
import { formatInstant, formatInstantDate } from "@/components/time-text";
import { calendarHref, type CalendarStaffOption } from "@/lib/admin/calendar";
import {
  getOwnedBusiness,
  requireBusinessAccess,
  requireUser,
} from "@/lib/auth-server";
import { localDateOf } from "@/lib/scheduling/local-minutes";
import {
  dayWindowOf,
  loadAgendaDay,
  loadAgendaWeek,
  loadCalendarOptions,
  loadServiceFocus,
  resolveCalendarParams,
  shiftLocalDate,
  uuidOrNull,
  weekDatesOf,
  type ServiceFocus,
} from "@/server/queries/agenda";

export const metadata: Metadata = {
  title: "Calendar",
};

/**
 * THE MASTER SCHEDULE.
 *
 * ═══ THE SERVER DOES ALL OF THE TIME, AND ALL OF THE NAVIGATION ═══
 *
 * Every instant, every minute of geometry, every heading and every href on
 * this page is computed here, in the business's timezone, with Temporal. The
 * client receives minutes and ISO instants and formats them; it never works
 * out what tomorrow is, because "tomorrow" is calendar arithmetic and the day
 * it goes wrong is the day the clocks change.
 *
 * ═══ THE WEEK IS DRAWN SMALLER, AND THE SCALE IS STILL HONEST ═══
 *
 * Seven columns will not fit at the day's 1.6 pixels per minute on a laptop, so
 * the week passes a smaller `pxPerMin`. That is a change of ZOOM, not of
 * encoding: within the week every segment is still exactly as tall as it is
 * long, so a 90-minute appointment is still three times a 30-minute one. What
 * must never happen is two different scales inside one drawing.
 *
 * `?service=` and `?staff=` are honoured because the services and staff screens
 * refuse a delete by pointing here — "N appointments still to come, show them".
 * `staff` narrows the lanes, which is a true thing to draw. `service` does NOT
 * filter: hiding every other appointment would draw their time as open, and an
 * owner glancing at that would see a free afternoon that is fully booked. It
 * answers the question beside the calendar instead. See `loadServiceFocus`.
 */

/** The week's zoom. An hour is 42px, so seven days fit a laptop. */
const WEEK_PX_PER_MIN = 0.7;

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    date?: string;
    staff?: string;
    service?: string;
  }>;
}) {
  const user = await requireUser("/admin/calendar");
  const owned = await getOwnedBusiness(user.id);

  /* Re-resolved through the gate every owner route uses, rather than trusted
     from the layout. A page that reads a business without asking whether the
     caller owns it is the page that eventually takes a slug from the URL. */
  const { business } = await requireBusinessAccess(owned!.id);

  const search = await searchParams;

  /* ONE CLOCK for the whole render. Two `new Date()` calls a few milliseconds
     apart can straddle a minute boundary, and the now line and the "is this
     today" test would then disagree with each other. */
  const now = new Date();

  const params = resolveCalendarParams(business, search, now);
  const today = localDateOf(now, business.timezone);

  /* Validated before it reaches a `uuid` column: an id that cannot name a row
     would make Postgres raise, and a raised error here is a 500 rather than an
     unfiltered calendar. */
  const focusServiceId = uuidOrNull(search.service);

  const [options, focus] = await Promise.all([
    loadCalendarOptions(business.id),
    focusServiceId
      ? loadServiceFocus(business.id, focusServiceId, business.timezone, now)
      : Promise.resolve(null),
  ]);

  const staffOptions: CalendarStaffOption[] = options.staff;

  if (params.view === "week") {
    const { week, staff, countsByDate } = await loadAgendaWeek(
      business.id,
      business.timezone,
      params.date,
      { staffId: params.staffId, now },
    );

    const dates = weekDatesOf(params.date);
    const columnDates = Object.fromEntries(dates.map((date) => [date, date]));

    /* The counts go in the column sublabels, where they answer "how full is
       Thursday" before anything has to be read off the strip. */
    const columns: RibbonColumn[] = week.columns.map((column) => ({
      ...column,
      sublabel: `${column.sublabel} · ${countsByDate[column.id] ?? 0}`,
    }));

    return (
      <div className="flex flex-col gap-8">
        <PageHeader
          eyebrow="Calendar"
          title="The week"
          description="Seven days at the same proportional scale, zoomed out. Press a day to work in it."
        />

        <ServiceFocusNotice focus={focus} staffId={params.staffId} />

        <CalendarWorkspace
          params={params}
          timeZone={business.timezone}
          currency={business.currency}
          businessName={business.name}
          slotGranularityMin={business.slotGranularityMin}
          nowInstant={now.toISOString()}
          heading={weekHeading(dates, business.timezone)}
          subheading={
            params.staffId
              ? staff.find((member) => member.id === params.staffId)?.name
              : undefined
          }
          previousHref={calendarHref({
            view: "week",
            date: shiftLocalDate(dates[0], -7),
            staffId: params.staffId,
          })}
          nextHref={calendarHref({
            view: "week",
            date: shiftLocalDate(dates[0], 7),
            staffId: params.staffId,
          })}
          todayHref={calendarHref({
            view: "week",
            date: today,
            staffId: params.staffId,
          })}
          isToday={dates.includes(today)}
          window={week.window}
          columns={columns}
          nowMinute={week.nowMinute}
          pxPerMin={WEEK_PX_PER_MIN}
          staff={staffOptions}
          services={options.services}
          streamFrom={dates[0]}
          streamTo={dates[6]}
          columnDates={columnDates}
        />
      </div>
    );
  }

  const { day, summary, appointments } = await loadAgendaDay(
    business.id,
    business.timezone,
    params.date,
    { staffId: params.staffId, now },
  );

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Calendar"
        title="The day"
        description="One column per staff member, drawn to scale. Press an appointment to open it, drag an empty stretch to block it out."
      />

      <ServiceFocusNotice focus={focus} staffId={params.staffId} />

      <CalendarWorkspace
        params={params}
        timeZone={business.timezone}
        currency={business.currency}
        businessName={business.name}
        slotGranularityMin={business.slotGranularityMin}
        nowInstant={now.toISOString()}
        heading={formatInstantDate(day.dayInstant, business.timezone)}
        subheading={
          params.date === today ? "Today" : relativeLabel(params.date, today)
        }
        previousHref={calendarHref({
          view: "day",
          date: shiftLocalDate(params.date, -1),
          staffId: params.staffId,
        })}
        nextHref={calendarHref({
          view: "day",
          date: shiftLocalDate(params.date, 1),
          staffId: params.staffId,
        })}
        todayHref={calendarHref({ view: "day", date: today, staffId: params.staffId })}
        isToday={params.date === today}
        window={day.window}
        columns={day.columns}
        nowMinute={day.nowMinute}
        staff={staffOptions}
        services={options.services}
        summary={summary}
        appointments={appointments}
        streamFrom={params.date}
        streamTo={params.date}
      />
    </div>
  );
}

/**
 * The answer to "show me the appointments stopping this delete".
 *
 * It sits ABOVE the calendar rather than filtering it, for the reason in
 * `loadServiceFocus`: a calendar with other people's appointments hidden draws
 * their time as open, and that is the one lie this screen must not tell.
 */
function ServiceFocusNotice({
  focus,
  staffId,
}: {
  focus: ServiceFocus | null;
  staffId: string | null;
}) {
  if (!focus) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-card border border-line bg-surface px-5 py-4">
      <p className="type-body text-ink-muted">
        {focus.upcomingCount === 0 ? (
          <>
            Nothing is booked for <strong className="text-ink">{focus.name}</strong>{" "}
            from here on. It is safe to remove.
          </>
        ) : (
          <>
            <strong className="text-ink">{focus.upcomingCount}</strong>{" "}
            appointment{focus.upcomingCount === 1 ? " is" : "s are"} still to
            come for{" "}
            <strong className="text-ink">{focus.name}</strong>. The calendar
            shows everything — hiding the rest would draw booked time as free.
          </>
        )}
      </p>

      {focus.firstDate ? (
        <Link
          href={calendarHref({ view: "day", date: focus.firstDate, staffId })}
          className="type-section shrink-0 text-accent underline-offset-4 hover:underline"
        >
          Go to the first one
        </Link>
      ) : null}
    </div>
  );
}

/**
 * "18 – 24 August", or "29 June – 5 July" across a month boundary.
 *
 * Built from the two days' own INSTANTS, formatted in the business's zone —
 * `dayWindowOf` gives the local midnight of each end and `formatInstant` reads
 * it back. No string slicing of an ISO date, which would be a second, quieter
 * implementation of a calendar.
 */
function weekHeading(dates: string[], timeZone: string): string {
  const first = new Date(dayWindowOf(dates[0], timeZone).start + 12 * 3_600_000)
    .toISOString();
  const last = new Date(dayWindowOf(dates[6], timeZone).start + 12 * 3_600_000)
    .toISOString();

  const sameMonth =
    formatInstant(first, timeZone, { month: "long" }) ===
    formatInstant(last, timeZone, { month: "long" });

  return sameMonth
    ? `${formatInstant(first, timeZone, { day: "numeric" })} – ${formatInstant(
        last,
        timeZone,
        { day: "numeric", month: "long" },
      )}`
    : `${formatInstant(first, timeZone, {
        day: "numeric",
        month: "long",
      })} – ${formatInstant(last, timeZone, { day: "numeric", month: "long" })}`;
}

/**
 * "Tomorrow", "Yesterday", or nothing.
 *
 * Deliberately only the two neighbours. "In 34 days" is a number nobody asked
 * for, and computing it would be calendar arithmetic for a caption.
 */
function relativeLabel(date: string, today: string): string | undefined {
  if (date === shiftLocalDate(today, 1)) {
    return "Tomorrow";
  }

  if (date === shiftLocalDate(today, -1)) {
    return "Yesterday";
  }

  return undefined;
}
