import "server-only";

import { and, eq, sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import { appointments, customers, services } from "@/db/schema";
import {
  BOOKING_WINDOW_MINUTES,
  MAX_BOOKINGS_PER_WINDOW,
  MAX_UPCOMING_PER_EMAIL,
  rateLimitMessage,
  type PolicyRefusal,
} from "@/lib/booking/policy";
import { Temporal, type TimeZoneId } from "@/lib/scheduling/temporal";

/**
 * EVERY POLICY CHECK, ENFORCED HERE.
 *
 * The client has copies of some of these — the lead time is why a slot is not
 * offered, the cancellation window is printed next to the consent box — and
 * every one of those copies exists ONLY TO EXPLAIN. None of them decides
 * anything. A booking is refused or allowed by this module, on the server, at
 * the moment of submit, against the database as it stands then.
 *
 * WHY "AT SUBMIT" IS THE ONLY MOMENT THAT COUNTS. A form takes minutes to fill
 * in. In that time the two-hour lead time can elapse, the owner can switch the
 * service off, the stylist can be deactivated, and the customer can open a
 * second tab and book the same slot from their phone. Everything checked when
 * the picker drew the day is a statement about the past by the time the button
 * is pressed, which is why the whole list runs again here rather than being
 * trusted.
 *
 * The one thing NOT in this file is double-booking. That is the exclusion
 * constraint's job, and no amount of checking in application code could do it
 * — see the note at the top of src/lib/scheduling/booking.ts.
 */

/* ---------------------------------------------------------------------------
   Lead time and horizon
--------------------------------------------------------------------------- */

/** Minutes, as the customer would say them: "two hours", "45 minutes". */
function saySpan(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} minutes`;
  }

  const hours = Math.round(minutes / 60);

  return hours === 1 ? "an hour" : `${hours} hours`;
}

/**
 * TIME PASSES WHILE A FORM IS FILLED IN.
 *
 * A business asking for two hours' notice, a customer who opens the form at
 * 11:58 for a 14:00 appointment and finishes typing at 12:03 — the slot was
 * legitimately offered and is now inside the window. Refusing at submit is the
 * only place this can be caught, and the message has to say what the rule IS,
 * not merely that it was broken.
 */
export function checkLeadTime(
  startsAt: Date,
  minLeadTimeMin: number,
  now: Date,
): PolicyRefusal | null {
  const earliest = now.getTime() + minLeadTimeMin * 60_000;

  if (startsAt.getTime() >= earliest) {
    return null;
  }

  return {
    code: "too-soon",
    message:
      minLeadTimeMin > 0
        ? `That time is too close now — bookings need ${saySpan(
            minLeadTimeMin,
          )} notice. Pick a later time and we will hold it for you.`
        : "That time has passed. Pick another one.",
  };
}

/**
 * The horizon, as a LOCAL DAY BOUNDARY.
 *
 * `max_advance_days` is a count of calendar days the customer can see, so the
 * last bookable day is today + N inclusive and the bound is the start of the
 * day after that — computed in the BUSINESS's zone, exactly as the
 * availability engine computes it. Any other reading and the calendar and this
 * check disagree by a day, which the customer discovers by filling in a form
 * for a slot that is then refused.
 */
export function checkMaxAdvance(
  startsAt: Date,
  maxAdvanceDays: number,
  timeZone: TimeZoneId,
  now: Date,
): PolicyRefusal | null {
  const latest = Temporal.Instant.fromEpochMilliseconds(now.getTime())
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .add({ days: maxAdvanceDays + 1 })
    .toZonedDateTime(timeZone)
    .startOfDay().epochMilliseconds;

  if (startsAt.getTime() < latest) {
    return null;
  }

  return {
    code: "too-far",
    message: `That is further ahead than this business takes bookings — ${maxAdvanceDays} days at most. Pick a nearer day.`,
  };
}

/* ---------------------------------------------------------------------------
   One person, one appointment at a time
--------------------------------------------------------------------------- */

/**
 * Does this email already have a CONFIRMED appointment across this time?
 *
 * The overlap is tested on the customer-facing span rather than on the stored
 * blocking range: the question is "are you already booked to be here then?",
 * which is about the appointment, not about the buffers around it.
 *
 * ON TELLING THEM. Answering "yes, at two o'clock" to anybody who types an
 * email address does leak something — but only to somebody who already knows
 * the address, already knows the business, and has already taken a real slot
 * out of the calendar to get to this form. Weighed against silently creating a
 * second booking that the business then has to unpick, and a customer who is
 * charged two deposits, it is the right trade. What is NOT offered is a link:
 * this browser has proved nothing about owning that appointment, and minting
 * an unauthenticated way into somebody else's booking to save them opening
 * their inbox would be the actual leak.
 */
export async function findOverlappingConfirmed(
  db: Db,
  input: {
    businessId: string;
    email: string;
    startsAt: Date;
    endsAt: Date;
    /** The hold being claimed, which must not match itself. */
    excludeAppointmentId: string;
  },
): Promise<PolicyRefusal | null> {
  const [existing] = await db
    .select({
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      serviceName: services.name,
    })
    .from(appointments)
    .innerJoin(customers, eq(customers.id, appointments.customerId))
    .innerJoin(services, eq(services.id, appointments.serviceId))
    .where(
      and(
        eq(customers.businessId, input.businessId),
        eq(customers.email, input.email),
        eq(appointments.status, "confirmed"),
        sql`${appointments.id} <> ${input.excludeAppointmentId}`,
        sql`tstzrange(${appointments.startsAt}, ${appointments.endsAt}, '[)')
            && tstzrange(${input.startsAt}, ${input.endsAt}, '[)')`,
      ),
    )
    .limit(1);

  if (!existing) {
    return null;
  }

  return {
    code: "duplicate",
    message:
      "This email already has a booking that overlaps that time. Open the link in that confirmation email to change or cancel it — we have not booked you in twice.",
    existing: {
      startsAt: existing.startsAt.toISOString(),
      endsAt: existing.endsAt.toISOString(),
      serviceName: existing.serviceName,
    },
  };
}

/**
 * How much of the calendar one email is allowed to be sitting on.
 *
 * See the long note on the constants in src/lib/booking/policy.ts for why the
 * limit lives at the email rather than at the hold. Two counts, one query
 * each, and both scoped to this business — a customer with three appointments
 * at their dentist has said nothing about their hairdresser.
 */
export async function checkRateLimit(
  db: Db,
  input: {
    businessId: string;
    email: string;
    now: Date;
    /** The hold being claimed, which must not count against its own limit. */
    excludeAppointmentId: string;
  },
): Promise<PolicyRefusal | null> {
  const [counts] = await db
    .select({
      upcoming: sql<number>`count(*) FILTER (
        WHERE ${appointments.status} IN ('held', 'confirmed')
          AND ${appointments.startsAt} > ${input.now}
      )::int`,
      recent: sql<number>`count(*) FILTER (
        WHERE ${appointments.createdAt} > ${new Date(
          input.now.getTime() - BOOKING_WINDOW_MINUTES * 60_000,
        )}
      )::int`,
    })
    .from(appointments)
    .innerJoin(customers, eq(customers.id, appointments.customerId))
    .where(
      and(
        eq(customers.businessId, input.businessId),
        eq(customers.email, input.email),
        sql`${appointments.id} <> ${input.excludeAppointmentId}`,
      ),
    );

  if ((counts?.upcoming ?? 0) >= MAX_UPCOMING_PER_EMAIL) {
    return { code: "rate-limited", message: rateLimitMessage("upcoming") };
  }

  if ((counts?.recent ?? 0) >= MAX_BOOKINGS_PER_WINDOW) {
    return { code: "rate-limited", message: rateLimitMessage("recent") };
  }

  return null;
}
