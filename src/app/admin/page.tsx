import type { Metadata } from "next";
import { Suspense } from "react";

import { CalendarWorkspace } from "@/components/admin/calendar/calendar-workspace";
import { PageHeader } from "@/components/page-header";
import {
  SkeletonRibbon,
  SkeletonTodayPanel,
} from "@/components/skeleton";
import { formatInstantDate } from "@/components/time-text";
import { calendarHref } from "@/lib/admin/calendar";
import {
  getOwnedBusiness,
  requireBusinessAccess,
  requireUser,
} from "@/lib/auth-server";
import { localDateOf } from "@/lib/scheduling/local-minutes";
import type { TimeZoneId } from "@/lib/scheduling/temporal";
import {
  dayWindowOf,
  loadAgendaDay,
  loadCalendarOptions,
  shiftLocalDate,
} from "@/server/queries/agenda";

export const metadata: Metadata = {
  title: "Today",
};

/**
 * The agenda: the Ribbon with one column per staff member, and today's numbers.
 *
 * This used to draw invented segments from src/lib/demo while the availability
 * engine was being built. It does not any more — the demo module is gone, and
 * this is the same loader, the same shaping and the same live stream as
 * /admin/calendar, fixed to today. The two pages differ in one thing: this one
 * cannot be navigated off today, because "Today" is what the shop opens to in
 * the morning and a page that remembers you were looking at next Thursday is
 * not that page.
 *
 * Everything is resolved in the BUSINESS's timezone. A shop in Auckland opens
 * on its own today, not on the server's.
 *
 * ═══ THE HEADING DOES NOT WAIT FOR THE DIARY ═══
 *
 * Which day it is needs the session and the business row, and nothing else —
 * both are already loaded by the time this function returns. The agenda itself
 * is five queries against the appointments table, so it is Suspended behind a
 * ribbon-shaped fallback drawn at the same scale. The owner gets the date, the
 * frame and the shape of the day immediately, and the day fills in underneath
 * without a single pixel moving.
 */
export default async function AdminTodayPage() {
  const user = await requireUser("/admin");
  const owned = await getOwnedBusiness(user.id);

  /* Re-resolved through `requireBusinessAccess` rather than trusted from the
     layout. It is the function every owner route uses, and using it here too
     keeps that habit unbroken — a page that reads a business without asking
     whether the caller owns it is exactly the page that eventually takes a
     slug from the URL. */
  const { business } = await requireBusinessAccess(owned!.id);

  /* ONE CLOCK for the whole render, so the now line and "is this today" cannot
     straddle a minute boundary and disagree. */
  const now = new Date();
  const timeZone = business.timezone as TimeZoneId;
  const today = localDateOf(now, business.timezone);

  /* The first instant of the local day, resolved with Temporal rather than
     taken from the agenda — so the heading can be written before a single
     appointment has been read. */
  const dayInstant = new Date(dayWindowOf(today, timeZone).start).toISOString();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Today"
        title={formatInstantDate(dayInstant, business.timezone)}
        description="Time is drawn to scale, so a 90-minute appointment takes up three times the space of a 30-minute one. Booked time is carved out of the day rather than stacked on top of it."
      />

      <Suspense
        fallback={
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <SkeletonRibbon columns={2} columnHeaders label="Loading today" />
            <SkeletonTodayPanel />
          </div>
        }
      >
        <TodayAgenda
          businessId={business.id}
          timeZone={business.timezone}
          currency={business.currency}
          businessName={business.name}
          slotGranularityMin={business.slotGranularityMin}
          today={today}
          now={now}
        />
      </Suspense>
    </div>
  );
}

/**
 * Everything that costs a query. Split out purely so the heading above it can
 * paint first; it is the same load, the same shaping and the same props the
 * page passed before.
 */
async function TodayAgenda({
  businessId,
  timeZone,
  currency,
  businessName,
  slotGranularityMin,
  today,
  now,
}: {
  businessId: string;
  timeZone: string;
  currency: string;
  businessName: string;
  slotGranularityMin: number;
  today: string;
  now: Date;
}) {
  const [{ day, summary, appointments }, options] = await Promise.all([
    loadAgendaDay(businessId, timeZone as TimeZoneId, today, { now }),
    loadCalendarOptions(businessId),
  ]);

  const heading = formatInstantDate(day.dayInstant, timeZone);

  return (
    <CalendarWorkspace
      params={{ view: "day", date: today, staffId: null }}
      timeZone={timeZone}
      currency={currency}
      businessName={businessName}
      slotGranularityMin={slotGranularityMin}
      nowInstant={now.toISOString()}
      heading={heading}
      subheading="Today"
      /* The arrows leave for the full calendar rather than paging this
         screen. Today is a destination, not a cursor. */
      previousHref={calendarHref({
        view: "day",
        date: shiftLocalDate(today, -1),
      })}
      nextHref={calendarHref({ view: "day", date: shiftLocalDate(today, 1) })}
      todayHref="/admin"
      isToday
      window={day.window}
      columns={day.columns}
      nowMinute={day.nowMinute}
      staff={options.staff}
      services={options.services}
      summary={summary}
      appointments={appointments}
      streamFrom={today}
      streamTo={today}
    />
  );
}
