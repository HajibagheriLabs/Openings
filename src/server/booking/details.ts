import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import {
  appointments as appointmentsTable,
  businesses,
  customers,
  services,
  staff,
} from "@/db/schema";
import type { BookingSummary, ConfirmedBooking } from "@/lib/booking/details";
import type { PolicyRefusal } from "@/lib/booking/policy";
import type { HoldSnapshot } from "@/lib/booking/hold";
import { readOwnAppointment, readOwnHold } from "@/lib/scheduling/booking";

import { readHoldCookie, type HoldCookie } from "./hold-cookie";
import { resolvePicker, toSnapshot, type PickerContext } from "./picker";
import { buildBookingSummary } from "./summary";

/**
 * Everything the details step is about, resolved from the COOKIE.
 *
 * THE HOLD NAMES THE BOOKING, NOT THE URL. The address still carries the
 * service, the staff member and the day so the back button works, but nothing
 * here reads them. The service, the person, the time and the price all come off
 * the held appointment row — which means a request that claims one service
 * while holding another cannot exist, because there is only one source and the
 * browser does not get a say in it.
 *
 * Used by the page to render the form and by the action to check the submit,
 * so what is on screen and what is enforced are the same resolution.
 */

export interface DetailsContext {
  cookie: HoldCookie;
  picker: PickerContext;
  hold: {
    id: string;
    startsAt: Date;
    endsAt: Date;
    staffId: string;
    serviceId: string;
    expiresAt: Date;
    priceCents: number;
    depositCents: number;
  };
  /** For the live countdown, in the same shape the picker uses. */
  snapshot: HoldSnapshot;
  summary: BookingSummary;
}

export type DetailsContextResult =
  | { ok: true; context: DetailsContext }
  | { ok: false; refusal: PolicyRefusal };

const HOLD_EXPIRED: PolicyRefusal = {
  code: "hold-expired",
  message:
    "Your hold ran out while you were filling this in. Nothing was booked and nothing was charged — pick a time again and we will hold it for another eight minutes.",
};

const UNAVAILABLE: PolicyRefusal = {
  code: "unavailable",
  message:
    "That appointment is no longer being offered. Pick another time and we will hold it for you.",
};

/**
 * Load it, or say why not.
 *
 * `now` is injected so the page, the action and the tests all decide expiry
 * against one clock rather than three.
 */
export async function loadDetailsContext(
  slug: string,
  now: Date = new Date(),
): Promise<DetailsContextResult> {
  const cookie = await readHoldCookie(slug);

  if (!cookie) {
    return { ok: false, refusal: HOLD_EXPIRED };
  }

  /* Token-checked inside. An appointment id on its own opens nothing. */
  const hold = await readOwnHold(db, cookie.appointmentId, cookie.manageToken);

  if (!hold || !hold.expiresAt) {
    return { ok: false, refusal: HOLD_EXPIRED };
  }

  /**
   * CHECK 1 — the hold still exists and has not expired.
   *
   * The row can outlive its deadline, because expiry is lazy and the janitor
   * is housekeeping. But the promise made to this customer was eight minutes,
   * and honouring a hold four minutes past it would mean the next booking
   * transaction could sweep the slot out from under them mid-payment.
   */
  if (hold.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, refusal: HOLD_EXPIRED };
  }

  /**
   * CHECK 2 — the service is still bookable and the staff member still does it.
   *
   * `resolvePicker` returns null for a service that has been switched off,
   * unassigned, or given a length that no longer fits the grid; the team it
   * returns contains only ACTIVE staff who still perform it. So a stylist
   * deactivated while the form was open fails the membership test below, and a
   * service switched off fails the resolve.
   */
  const picker = await resolvePicker({
    slug,
    serviceId: hold.serviceId,
    staffId: hold.staffId,
  });

  if (!picker) {
    return { ok: false, refusal: UNAVAILABLE };
  }

  const staff = picker.team.find((member) => member.id === hold.staffId);

  if (!staff) {
    return { ok: false, refusal: UNAVAILABLE };
  }

  return {
    ok: true,
    context: {
      cookie,
      picker,
      hold: { ...hold, expiresAt: hold.expiresAt },
      snapshot: toSnapshot(
        hold.id,
        hold.startsAt,
        hold.endsAt,
        hold.expiresAt,
        null,
      ),
      summary: buildBookingSummary({
        business: {
          timezone: picker.timeZone,
          currency: picker.currency,
          cancellationWindowHours: picker.policy.cancellationWindowHours,
          allowReschedule: picker.policy.allowReschedule,
        },
        serviceName: picker.service.name,
        durationMin: picker.service.durationMin,
        staffName: staff.name,
        startsAt: hold.startsAt,
        endsAt: hold.endsAt,
        priceCents: hold.priceCents,
        depositCents: hold.depositCents,
      }),
    },
  };
}

/**
 * The booking this browser just made, for the confirmation screen.
 *
 * TWO WAYS TO NAME IT, because one is not enough.
 *
 * The hold cookie is the first: once an appointment is confirmed the cookie
 * stops meaning "the slot I am holding" and starts meaning "the appointment I
 * just made", which is what makes a refresh of the confirmation screen work.
 * But it is written to live about as long as a hold, and a customer who spent
 * five minutes on Stripe's page can arrive back without one.
 *
 * So the Stripe Checkout Session id is the second. Stripe generated it, put it
 * in the return URL it handed THIS browser, and it names exactly one
 * appointment. It is scoped to the business in the query, and it is only ever
 * a way to READ a confirmation — changing or cancelling still needs the manage
 * token from the email.
 *
 * Returns null for anything that is not a confirmed appointment reachable one
 * of those two ways, so a stale cookie simply falls through to the picker
 * rather than erroring.
 */
export async function loadConfirmedBooking(
  slug: string,
  sessionId: string | null = null,
): Promise<ConfirmedBooking | null> {
  const appointmentId = await resolveConfirmedAppointmentId(slug, sessionId);

  if (!appointmentId) {
    return null;
  }

  const [row] = await db
    .select({
      status: appointmentsTable.status,
      startsAt: appointmentsTable.startsAt,
      endsAt: appointmentsTable.endsAt,
      priceCents: appointmentsTable.priceCents,
      depositCents: appointmentsTable.depositCents,
      paymentIntentId: appointmentsTable.stripePaymentIntentId,
      serviceName: services.name,
      durationMin: services.durationMin,
      staffName: staff.name,
      email: customers.email,
      timezone: businesses.timezone,
      currency: businesses.currency,
      cancellationWindowHours: businesses.cancellationWindowHours,
      allowReschedule: businesses.allowReschedule,
    })
    .from(appointmentsTable)
    .innerJoin(services, eq(services.id, appointmentsTable.serviceId))
    .innerJoin(staff, eq(staff.id, appointmentsTable.staffId))
    .innerJoin(customers, eq(customers.id, appointmentsTable.customerId))
    .innerJoin(businesses, eq(businesses.id, appointmentsTable.businessId))
    .where(eq(appointmentsTable.id, appointmentId))
    .limit(1);

  if (!row || row.status !== "confirmed") {
    return null;
  }

  return {
    appointmentId,
    email: row.email,
    /* The PAYMENT says the deposit was taken, not the status. See the note on
       `depositPaid` — a booking can be confirmed with the deposit still owed
       at the counter. */
    depositPaid: row.depositCents > 0 && row.paymentIntentId !== null,
    summary: buildBookingSummary({
      business: {
        timezone: row.timezone,
        currency: row.currency,
        cancellationWindowHours: row.cancellationWindowHours,
        allowReschedule: row.allowReschedule,
      },
      serviceName: row.serviceName,
      durationMin: row.durationMin,
      staffName: row.staffName,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      priceCents: row.priceCents,
      depositCents: row.depositCents,
    }),
  };
}

/**
 * The appointment id, from the cookie if this browser has one and from the
 * Stripe session if it does not.
 *
 * The cookie is tried first because it is token-checked, which is the stronger
 * claim of the two.
 */
async function resolveConfirmedAppointmentId(
  slug: string,
  sessionId: string | null,
): Promise<string | null> {
  const cookie = await readHoldCookie(slug);

  if (cookie) {
    const appointment = await readOwnAppointment(
      db,
      cookie.appointmentId,
      cookie.manageToken,
    );

    if (appointment) {
      return appointment.id;
    }
  }

  if (!sessionId) {
    return null;
  }

  const [row] = await db
    .select({ id: appointmentsTable.id })
    .from(appointmentsTable)
    .innerJoin(businesses, eq(businesses.id, appointmentsTable.businessId))
    .where(
      and(
        eq(appointmentsTable.stripeCheckoutSessionId, sessionId),
        eq(businesses.slug, slug),
      ),
    )
    .limit(1);

  return row?.id ?? null;
}
