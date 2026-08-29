import "server-only";

import { db } from "@/db";
import type { AppointmentStatus } from "@/db/schema";
import { bookingUrl } from "@/lib/booking/url";
import { bookingViewOf } from "@/lib/notifications/compose";
import { loadNotificationSubject } from "@/lib/notifications/context";
import type { EmailBooking } from "@/lib/notifications/view";
import { readOwnAppointment } from "@/lib/scheduling/booking";

/**
 * The page every booking email links to.
 *
 * AUTHORIZED BY THE MANAGE TOKEN AND NOTHING ELSE. Customers never have an
 * account here — the only login in this product belongs to the business owner
 * — so "is this appointment yours?" is answered by a secret in the link,
 * compared in constant time against the hash on the row. See
 * `readOwnAppointment` and the note in src/lib/notifications/manage-link.ts.
 *
 * THE FACTS COME FROM THE SAME PLACE THE EMAILS DO. `loadNotificationSubject`
 * and `bookingViewOf` already resolve an appointment into exactly what a
 * person needs told about it — the time in both zones, the money split, the
 * policy, the calendar links. Loading it a second way here would be a second
 * chance for the page and the confirmation to disagree about the same booking,
 * which is the one thing this page exists to prevent.
 *
 * WHAT IT DOES NOT SHOW: the business's marketing description. That belongs on
 * the booking page, where somebody is deciding; a person who is already booked
 * wants their time, their receipt and a way out.
 */

export interface ManageView {
  appointmentId: string;
  status: AppointmentStatus;
  booking: EmailBooking;
  /** For the header — the shop's own clock, stated as on every other screen. */
  timeZone: string;
  address: string | null;
  /** Set only on a cancelled appointment. */
  cancelledBy: "customer" | "business" | null;
  cancellationReason: string | null;
  refundedCents: number | null;
  /** Where to book again, as a path within this app. */
  rebookPath: string;
}

/**
 * The appointment behind a manage link, or null.
 *
 * Null covers a wrong token, an unknown id and an appointment that is still
 * only HELD — the page renders one "no appointment here" for all three, so the
 * route cannot be used to find out whether an id exists.
 */
export async function loadManageView(
  appointmentId: string,
  manageToken: string | null,
): Promise<ManageView | null> {
  if (!manageToken) {
    return null;
  }

  const appointment = await readOwnAppointment(db, appointmentId, manageToken);

  if (!appointment || appointment.status === "held") {
    return null;
  }

  const subject = await loadNotificationSubject(db, appointmentId, {
    /* Nothing here composes an email; the kind only satisfies the shared
       loader, and nothing below reads it. */
    kind: "confirmation",
  });

  if (!subject) {
    return null;
  }

  return {
    appointmentId,
    status: appointment.status,
    booking: bookingViewOf(subject),
    timeZone: subject.business.timeZone,
    address: subject.business.address,
    cancelledBy: appointment.cancelledBy,
    cancellationReason: appointment.cancellationReason,
    refundedCents: appointment.refundedCents,
    rebookPath: bookingUrl(subject.business.slug, {
      service: subject.service.id,
    }),
  };
}
