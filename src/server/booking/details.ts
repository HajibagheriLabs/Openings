import "server-only";

import { eq } from "drizzle-orm";

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
 * Reads the same cookie the hold used — once an appointment is confirmed the
 * cookie stops meaning "the slot I am holding" and starts meaning "the
 * appointment I just made", which is what makes a refresh of the confirmation
 * screen work. Returns null for anything that is not a confirmed appointment
 * belonging to this token, so a stale cookie simply falls through to the
 * picker rather than erroring.
 */
export async function loadConfirmedBooking(
  slug: string,
): Promise<ConfirmedBooking | null> {
  const cookie = await readHoldCookie(slug);

  if (!cookie) {
    return null;
  }

  const appointment = await readOwnAppointment(
    db,
    cookie.appointmentId,
    cookie.manageToken,
  );

  if (!appointment || appointment.status !== "confirmed") {
    return null;
  }

  const [row] = await db
    .select({
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
    .where(eq(appointmentsTable.id, appointment.id))
    .limit(1);

  if (!row) {
    return null;
  }

  return {
    appointmentId: appointment.id,
    email: row.email,
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
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      priceCents: appointment.priceCents,
      depositCents: appointment.depositCents,
    }),
  };
}
