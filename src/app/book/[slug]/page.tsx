import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import {
  BookingChoices,
  type BookingChoice,
} from "@/components/booking/booking-choices";
import { BusinessHeader } from "@/components/booking/business-header";
import { DateStep } from "@/components/booking/date-step";
import { DayPicker } from "@/components/booking/day-picker";
import { NoServices } from "@/components/booking/no-services";
import { ServiceStep } from "@/components/booking/service-step";
import { StaffStep } from "@/components/booking/staff-step";
import { formatInstantDate } from "@/components/time-text";
import { db } from "@/db";
import { buildBookingFlow } from "@/lib/booking/flow";
import { ANY_STAFF, bookingUrl, parseBookingQuery } from "@/lib/booking/url";
import { buildBookingDemoDay } from "@/lib/demo/ribbon-demo";
import {
  currentMonthIn,
  loadMonthSummary,
  localDateInstant,
  monthOf,
  type DayOpenings,
} from "@/lib/scheduling/month-summary";
import { loadPublicBusiness } from "@/server/queries/booking-page";
import { loadBookableServices } from "@/server/queries/catalog";

/**
 * The public booking page. No session, no account, ever — customers book as
 * guests and the only person with a login is the owner.
 *
 * ONE SERVER COMPONENT DECIDES WHICH STEP THIS IS. Every choice lives in the
 * query string (see src/lib/booking/url.ts), so rendering the right step is a
 * pure function of the URL and the database: read the parameters, resolve each
 * one against real rows, and fall to the earliest step that still has an
 * unanswered question. There is no wizard state machine, because there is no
 * state to machine — a refresh, a shared link and the back button all arrive
 * here the same way and get the same answer.
 *
 * Anything unusable is DROPPED rather than rejected. A service that was
 * deleted this morning, a stylist who left, a day that filled up while the
 * link sat in someone's messages: each one silently stops counting as an
 * answer, and the visitor lands on the step that asks it again.
 *
 * Data loading is a chain rather than a fan-out on purpose: which staff to
 * offer depends on the service, and which month to summarise depends on the
 * staff. Each step's query only runs once its answer is actually needed.
 */

async function loadBusinessFor(slug: string) {
  const business = await loadPublicBusiness(slug);

  if (!business) {
    notFound();
  }

  return business;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const business = await loadPublicBusiness(slug);

  if (!business) {
    return { title: "No booking page here" };
  }

  return {
    title: `Book at ${business.name}`,
    description:
      business.description ??
      `Choose a service and a time at ${business.name}.`,
  };
}

export default async function BookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const business = await loadBusinessFor(slug);

  /**
   * ONE CLOCK FOR THE WHOLE RENDER. Lead time, the horizon, which holds have
   * expired and which day is "today" are all decided against this single
   * value, so two of them cannot disagree because a millisecond passed between
   * two queries.
   */
  const now = new Date();
  const nowInstant = now.toISOString();

  const header = <BusinessHeader business={business} instant={nowInstant} />;

  /**
   * BOOKABLE, not merely active.
   *
   * The same predicate the admin's services list flags with — one function, so
   * what the owner is told and what the customer is shown cannot drift apart.
   * An active service with nobody active assigned to it must not reach this
   * page: the availability algorithm would have no staff to expand hours for
   * and would render an empty calendar with no explanation.
   */
  const services = await loadBookableServices(
    business.id,
    business.slotGranularityMin,
  );

  if (services.length === 0) {
    return (
      <NoServices
        header={header}
        contactEmail={business.contactEmail}
        contactPhone={business.contactPhone}
      />
    );
  }

  const query = parseBookingQuery(await searchParams);

  /* ---------------------------------------------------------------------
     Step 1 — the service
  --------------------------------------------------------------------- */

  /* One service is not a choice. Skipping the step is not a shortcut here —
     it is refusing to ask a question with one possible answer. */
  const service =
    services.length === 1
      ? services[0]
      : (services.find((candidate) => candidate.id === query.service) ?? null);

  const activeStaffOf = (candidate: (typeof services)[number]) =>
    candidate.staff.filter((member) => member.isActive);

  if (!service) {
    /* The flow's length is not yet known — it depends on how many people
       perform the service that has not been chosen. The widest team is the
       longest the flow could be, and a progress line that may jump forward
       later is better than one that grows. */
    const widestTeam = Math.max(
      ...services.map((candidate) => activeStaffOf(candidate).length),
    );

    const flow = buildBookingFlow({
      serviceCount: services.length,
      staffCount: widestTeam,
      chosen: { service: false, staff: false, date: false },
    });

    return (
      <ServiceStep
        slug={slug}
        currency={business.currency}
        services={services}
        step={flow.step}
        totalSteps={flow.total}
        header={header}
      />
    );
  }

  const serviceChoice: BookingChoice | null =
    services.length > 1
      ? { value: service.name, noun: "service", href: bookingUrl(slug) }
      : null;

  /* ---------------------------------------------------------------------
     Step 2 — who
  --------------------------------------------------------------------- */

  const team = activeStaffOf(service);
  const staffStepExists = team.length > 1;

  /* A staff id from a stale link is only an answer if that person is still
     active and still performs this service. */
  const chosenStaff =
    query.staff === ANY_STAFF ||
    (query.staff !== null && team.some((member) => member.id === query.staff))
      ? query.staff
      : null;

  if (staffStepExists && chosenStaff === null) {
    const flow = buildBookingFlow({
      serviceCount: services.length,
      staffCount: team.length,
      chosen: { service: true, staff: false, date: false },
    });

    return (
      <StaffStep
        slug={slug}
        serviceId={service.id}
        staff={team}
        step={flow.step}
        totalSteps={flow.total}
        header={header}
        choices={
          <BookingChoices choices={serviceChoice ? [serviceChoice] : []} />
        }
      />
    );
  }

  /* When the step does not exist there is nobody to choose between, and the
     availability query is asked for whoever is free — which, with one
     qualified person, is that person. */
  const staffId = staffStepExists ? (chosenStaff as string) : ANY_STAFF;
  /* Carried in links only when the visitor actually chose it, so a
     single-stylist business keeps a clean address. */
  const staffParam = staffStepExists ? staffId : undefined;

  const staffChoice: BookingChoice | null = staffStepExists
    ? {
        value:
          staffId === ANY_STAFF
            ? "Anyone available"
            : (team.find((member) => member.id === staffId)?.name ?? "Anyone"),
        noun: "staff member",
        href: bookingUrl(slug, { service: service.id }),
      }
    : null;

  /* ---------------------------------------------------------------------
     Step 3 — the day
  --------------------------------------------------------------------- */

  /**
   * A chosen date decides the month. `month` is navigation state and only
   * matters while nothing is chosen; letting the two disagree would mean a
   * calendar showing September with a Tuesday in October selected.
   */
  const month = query.date
    ? monthOf(query.date)
    : (query.month ?? currentMonthIn(business.timezone, now));

  const summary = await loadMonthSummary({
    db,
    businessId: business.id,
    serviceId: service.id,
    staffId,
    timeZone: business.timezone,
    maxAdvanceDays: business.maxAdvanceDays,
    month,
    now,
  });

  /* Only possible if the service was deleted between two queries in the same
     request. Start the visitor over rather than showing them a page about a
     service that no longer exists. */
  if (!summary) {
    redirect(bookingUrl(slug));
  }

  /**
   * A day is selectable exactly when it has an opening, and the narrowing says
   * so: `firstStartsAt` being a string is what makes the date labellable
   * further down without a non-null assertion.
   */
  const selectedDay = query.date
    ? (summary.days.find(
        (day): day is DayOpenings & { firstStartsAt: string } =>
          day.date === query.date && day.firstStartsAt !== null,
      ) ?? null)
    : null;

  if (!selectedDay) {
    const flow = buildBookingFlow({
      serviceCount: services.length,
      staffCount: team.length,
      chosen: { service: true, staff: true, date: false },
    });

    return (
      <DateStep
        slug={slug}
        serviceId={service.id}
        staffId={staffParam ?? null}
        summary={summary}
        /* A link to a day that has since filled up is a real arrival, and
           saying so is the difference between "they changed the page" and
           "somebody got there first". */
        unavailableDate={
          query.date
            ? formatInstantDate(
                localDateInstant(query.date, business.timezone),
                business.timezone,
              )
            : null
        }
        step={flow.step}
        totalSteps={flow.total}
        header={header}
        choices={
          <BookingChoices
            choices={[serviceChoice, staffChoice].filter(
              (choice): choice is BookingChoice => choice !== null,
            )}
          />
        }
      />
    );
  }

  /* ---------------------------------------------------------------------
     Step 4 — the time
  --------------------------------------------------------------------- */

  const flow = buildBookingFlow({
    serviceCount: services.length,
    staffCount: team.length,
    chosen: { service: true, staff: true, date: true },
  });

  const day = buildBookingDemoDay(
    business.timezone,
    service.durationMin,
    selectedDay.date,
  );

  const dateChoice: BookingChoice = {
    value: formatInstantDate(selectedDay.firstStartsAt, business.timezone),
    noun: "day",
    href: bookingUrl(slug, {
      service: service.id,
      staff: staffParam,
      month: summary.month,
    }),
  };

  return (
    <DayPicker
      business={{
        name: business.name,
        timezone: business.timezone,
        currency: business.currency,
      }}
      service={{
        name: service.name,
        durationMin: service.durationMin,
        priceCents: service.priceCents,
      }}
      day={day}
      step={flow.step}
      totalSteps={flow.total}
      header={header}
      choices={
        <BookingChoices
          choices={[serviceChoice, staffChoice, dateChoice].filter(
            (choice): choice is BookingChoice => choice !== null,
          )}
        />
      }
    />
  );
}
