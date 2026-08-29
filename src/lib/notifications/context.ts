import "server-only";

import { eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import {
  appointments,
  businesses,
  customers,
  services,
  staff,
  type NotificationKind,
} from "@/db/schema";

import type { NotificationSubject } from "./compose";
import type { NotificationPayload } from "./payload";
import { appOrigin, deriveManageToken } from "./manage-link";

/**
 * One query, everything a message needs.
 *
 * THE FACTS COME OFF THE APPOINTMENT, NOT OFF THE OUTBOX ROW. A notification
 * says which message to send and to whom; what it says is read here, at send
 * time, from the row as it stands. That is what makes a reminder queued three
 * weeks ago describe the appointment as it is today rather than as it was —
 * and it is why a reschedule does not have to hunt down and rewrite a pending
 * reminder.
 *
 * The one exception is the outbox row's `payload`, which carries the handful
 * of facts the appointment genuinely no longer has: the time a reschedule
 * moved FROM, the money on a refund. See src/lib/notifications/payload.ts.
 */

/**
 * The four rows behind one message, or null when they are not all there.
 *
 * Null is a real answer, not a failure. A notification is deleted with its
 * appointment (ON DELETE CASCADE), so the only way to reach a missing row is a
 * `held` appointment with no customer yet — which should never have a
 * notification against it, and which the worker reports rather than retrying
 * forever.
 */
export interface SubjectOptions {
  /**
   * Which message this is for.
   *
   * The .ics route has no notification behind it — it serves whatever invite
   * the appointment currently implies — so it passes `confirmation` and then
   * ignores the field entirely, building the calendar part from the row's
   * status instead. Everything else passes the outbox row's own kind.
   */
  kind: NotificationKind;
  /** The outbox row's extra facts, when it has any. */
  payload?: NotificationPayload | null;
  /** Overrides the configured origin. Used by tests. */
  origin?: string;
  /** DTSTAMP, for a test that compares two invites byte for byte. */
  stamp?: Date;
}

export async function loadNotificationSubject(
  db: Db,
  appointmentId: string,
  options: SubjectOptions,
): Promise<NotificationSubject | null> {
  const [row] = await db
    .select({
      appointment: appointments,
      business: businesses,
      service: services,
      staff: staff,
      customer: customers,
    })
    .from(appointments)
    .innerJoin(businesses, eq(businesses.id, appointments.businessId))
    .innerJoin(services, eq(services.id, appointments.serviceId))
    .innerJoin(staff, eq(staff.id, appointments.staffId))
    /* INNER, deliberately. A message about an appointment nobody is attached to
       has no name to open with and no policy to state; the worker treats it as
       unsendable rather than guessing. */
    .innerJoin(customers, eq(customers.id, appointments.customerId))
    .where(eq(appointments.id, appointmentId))
    .limit(1);

  if (!row) {
    return null;
  }

  return {
    kind: options.kind,
    payload: options.payload ?? null,
    origin: options.origin ?? appOrigin(),
    /**
     * Recomputed, not remembered. The row stores only a hash and the outbox
     * stores no secrets at all — see the long note in ./manage-link.ts for why
     * this is derivable and why rotating it instead would break the customer's
     * own confirmation screen.
     */
    manageToken: deriveManageToken(row.appointment.icsUid),
    stamp: options.stamp,

    appointment: {
      id: row.appointment.id,
      icsUid: row.appointment.icsUid,
      icsSequence: row.appointment.icsSequence,
      startsAt: row.appointment.startsAt,
      endsAt: row.appointment.endsAt,
      priceCents: row.appointment.priceCents,
      depositCents: row.appointment.depositCents,
      /* THE PAYMENT says the deposit was taken, never the status: an owner can
         enter a booking by hand and take the deposit at the counter, and
         telling that customer it is already paid is a small lie with a real
         argument at the end of it. */
      depositPaid:
        row.appointment.depositCents > 0 &&
        row.appointment.stripePaymentIntentId !== null,
      customerNote: row.appointment.customerNote,
      cancelledBy: row.appointment.cancelledBy,
      cancellationReason: row.appointment.cancellationReason,
      refundedCents: row.appointment.refundedCents,
    },

    business: {
      name: row.business.name,
      slug: row.business.slug,
      timeZone: row.business.timezone,
      currency: row.business.currency,
      contactEmail: row.business.contactEmail,
      contactPhone: row.business.contactPhone,
      address: row.business.address,
      cancellationWindowHours: row.business.cancellationWindowHours,
      allowReschedule: row.business.allowReschedule,
    },

    service: {
      id: row.service.id,
      name: row.service.name,
      durationMin: row.service.durationMin,
    },

    staff: { name: row.staff.name },

    customer: {
      name: row.customer.name,
      email: row.customer.email,
      phone: row.customer.phone,
      timeZone: row.customer.timezone,
    },
  };
}
