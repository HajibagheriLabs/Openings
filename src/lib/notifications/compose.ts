import { plainTextSelectors, render, toPlainText } from "@react-email/components";
import type { ReactNode } from "react";

import BookingCancellation from "../../../emails/booking/cancellation";
import BookingConfirmation from "../../../emails/booking/confirmation";
import NewBooking from "../../../emails/booking/new-booking";
import RefundNotice from "../../../emails/booking/refund";
import BookingReminder from "../../../emails/booking/reminder";
import BookingReschedule from "../../../emails/booking/reschedule";
import SlotLost from "../../../emails/booking/slot-lost";

import type { AppointmentStatus, NotificationKind } from "@/db/schema";
import { formatInstant, formatInstantRange } from "@/components/time-text";
import { bookingUrl } from "@/lib/booking/url";
import { cancellationPolicyLines } from "@/lib/booking/policy";
import { formatCents } from "@/lib/money";

import {
  buildInvite,
  INVITE_FILENAME,
  inviteContentType,
  type InviteMethod,
} from "./invite";
import { googleCalendarUrl, icsUrl, manageUrl } from "./links";
import type { NotificationPayload } from "./payload";
import { visitorZoneFor, type EmailBooking } from "./view";

/**
 * One outbox row becomes one message.
 *
 * PURE, AND DELIBERATELY SO. Everything this needs — the appointment, the
 * business, the customer, the origin, the manage token — is handed to it. It
 * opens no connection, reads no configuration and has no clock of its own
 * beyond an injectable stamp, which is what makes every template and every
 * .ics assertable in a plain unit test rather than in a mail client.
 *
 * THE TEMPLATE LIVES IN CODE, NEVER IN THE ROW. A queued notification says
 * WHICH message to send, not what it says, so a wording fix reaches every row
 * still waiting in the queue — including a reminder written three weeks ago.
 *
 * WHICH MESSAGES CARRY A CALENDAR PART, and why:
 *
 *   confirmation  REQUEST  the first invitation. Sequence 0.
 *   reschedule    REQUEST  same UID, higher sequence — calendars MOVE the
 *                          event they already have rather than adding a second.
 *   cancellation  CANCEL   same UID, higher sequence again, STATUS:CANCELLED,
 *                          and NO still-valid copy anywhere in the message.
 *   reminder      none     it would carry the same UID at the same sequence,
 *                          which every client correctly ignores — and a second
 *                          attachment tips some of them out of rendering the
 *                          message as a message.
 *   new_booking   none     the owner's calendar of record is the admin agenda,
 *                          and an ORGANIZER receiving their own REQUEST is the
 *                          case clients handle least consistently.
 *   slot_lost     none     there is nothing to put in a calendar. There never
 *                          was: the appointment was never confirmed.
 *   refund        none     money moved; the diary did not.
 */

/* ===========================================================================
   What the composer is given
   =========================================================================== */

export interface NotificationSubject {
  kind: NotificationKind;
  /** The row's extra facts, when the kind has any. Never a rendered message. */
  payload: NotificationPayload | null;
  /** Absolute origin for every link in the message, e.g. "https://openings.app". */
  origin: string;
  /**
   * The plaintext manage token, recomputed by the caller from the appointment's
   * UID. See src/lib/notifications/manage-link.ts for why it can be recomputed
   * at all.
   */
  manageToken: string;
  /**
   * DTSTAMP and nothing else. Injectable so a test can compare two invites
   * byte for byte; defaults to now, which is what it means in production.
   */
  stamp?: Date;

  appointment: {
    id: string;
    /** As it stands NOW, not as it stood when the message was queued. */
    status: AppointmentStatus;
    icsUid: string;
    /** 0 at confirmation, incremented by every write that changes the event. */
    icsSequence: number;
    startsAt: Date;
    endsAt: Date;
    priceCents: number;
    depositCents: number;
    /** Whether the deposit was actually taken, or is still due on the day. */
    depositPaid: boolean;
    customerNote: string | null;
    cancelledBy: "customer" | "business" | null;
    cancellationReason: string | null;
    refundedCents: number | null;
  };

  business: {
    name: string;
    slug: string;
    timeZone: string;
    currency: string;
    contactEmail: string;
    contactPhone: string | null;
    address: string | null;
    cancellationWindowHours: number;
    allowReschedule: boolean;
  };

  service: { id: string; name: string; durationMin: number };
  staff: { name: string };
  customer: {
    name: string;
    email: string;
    phone: string | null;
    /** Their own zone, when their browser gave one. Null is common and fine. */
    timeZone: string | null;
  };
}

/** A message, ready for the mailer. */
export interface ComposedEmail {
  subject: string;
  html: string;
  /** Never optional. It is what spam filters read, and what a watch renders. */
  text: string;
  /** The single calendar part, or null for the kinds that carry none. */
  calendar: {
    method: InviteMethod;
    filename: string;
    contentType: string;
    content: string;
  } | null;
}

/* ===========================================================================
   The view model
   =========================================================================== */

/** Everything the templates read, resolved once. */
export function bookingViewOf(subject: NotificationSubject): EmailBooking {
  const startsAt = subject.appointment.startsAt.toISOString();
  const endsAt = subject.appointment.endsAt.toISOString();
  const token = subject.manageToken;

  const balanceCents = Math.max(
    subject.appointment.priceCents - subject.appointment.depositCents,
    0,
  );

  return {
    businessName: subject.business.name,
    serviceName: subject.service.name,
    staffName: subject.staff.name,
    durationMin: subject.service.durationMin,
    times: {
      startsAt,
      endsAt,
      timeZone: subject.business.timeZone,
      visitorTimeZone: visitorZoneFor(
        startsAt,
        subject.business.timeZone,
        subject.customer.timeZone,
      ),
    },
    location: subject.business.address,
    contactEmail: subject.business.contactEmail,
    contactPhone: subject.business.contactPhone,

    currency: subject.business.currency,
    priceCents: subject.appointment.priceCents,
    depositCents: subject.appointment.depositCents,
    depositPaid: subject.appointment.depositPaid,
    balanceCents,

    customerName: subject.customer.name,
    customerEmail: subject.customer.email,
    customerPhone: subject.customer.phone,
    customerNote: subject.appointment.customerNote,

    policyLines: cancellationPolicyLines({
      cancellationWindowHours: subject.business.cancellationWindowHours,
      allowReschedule: subject.business.allowReschedule,
      depositCents: subject.appointment.depositCents,
    }),

    manageUrl: manageUrl(subject.origin, subject.appointment.id, token),
    icsUrl: icsUrl(subject.origin, subject.appointment.id, token),
    googleUrl: googleCalendarUrl({
      title: `${subject.service.name} — ${subject.business.name}`,
      startsAt: subject.appointment.startsAt,
      endsAt: subject.appointment.endsAt,
      details: inviteDescription(subject),
      location: subject.business.address,
    }),
  };
}

/* ===========================================================================
   The calendar part
   =========================================================================== */

/**
 * What the event says when somebody opens it in their calendar three weeks
 * later.
 *
 * IT CARRIES THE MANAGE LINK, because a calendar entry is exactly where
 * somebody looks when they realise they cannot make it — not their inbox, and
 * certainly not a booking confirmation they have long since archived.
 *
 * Plain text, short lines. A description is rendered as a blob by most
 * calendars and folded at 75 octets by the format itself.
 */
function inviteDescription(subject: NotificationSubject): string {
  const lines = [
    `${subject.service.name} with ${subject.staff.name} at ${subject.business.name}.`,
    "",
    `Change or cancel: ${manageUrl(
      subject.origin,
      subject.appointment.id,
      subject.manageToken,
    )}`,
  ];

  if (subject.business.contactPhone) {
    lines.push(`Phone: ${subject.business.contactPhone}`);
  }

  return lines.join("\n");
}

/** The .ics for this appointment, at whatever sequence the row is on. */
export function inviteFor(
  subject: NotificationSubject,
  method: InviteMethod,
): string {
  return buildInvite({
    method,
    uid: subject.appointment.icsUid,
    sequence: subject.appointment.icsSequence,
    startsAt: subject.appointment.startsAt,
    endsAt: subject.appointment.endsAt,
    stamp: subject.stamp,
    summary: `${subject.service.name} — ${subject.business.name}`,
    description: inviteDescription(subject),
    location: subject.business.address,
    organizer: {
      name: subject.business.name,
      email: subject.business.contactEmail,
    },
    attendee: { name: subject.customer.name, email: subject.customer.email },
    url: manageUrl(subject.origin, subject.appointment.id, subject.manageToken),
  });
}

function calendarPart(
  subject: NotificationSubject,
  method: InviteMethod,
): ComposedEmail["calendar"] {
  return {
    method,
    filename: INVITE_FILENAME,
    contentType: inviteContentType(method),
    content: inviteFor(subject, method),
  };
}

/* ===========================================================================
   Subjects
   =========================================================================== */

/** "Thu, 3 Sep" — short enough to sit in a subject line beside a time. */
function shortDate(subject: NotificationSubject): string {
  return formatInstant(
    subject.appointment.startsAt.toISOString(),
    subject.business.timeZone,
    { weekday: "short", day: "numeric", month: "short" },
  );
}

/** "14:00", in the business's zone. Always the business's. */
function shortTime(subject: NotificationSubject): string {
  return formatInstant(
    subject.appointment.startsAt.toISOString(),
    subject.business.timeZone,
  );
}

/* ===========================================================================
   Compose
   =========================================================================== */

/**
 * The fact panel, in the plain-text part.
 *
 * Without this the label/value table is flattened into one run-on paragraph —
 * "ServiceCut and colourWithRosa Meier" — which is what a spam filter scores
 * and what a screen reader announces. The rule has to target this one table
 * rather than `table` in general, because React Email's own Section and
 * Container are tables too and turning those into data tables would put the
 * whole message in a grid.
 */
const FACT_TABLE_SELECTOR = {
  selector: "[data-facts=true]",
  format: "dataTable",
} as const;

/** Render once, and derive the text part from the same markup. */
async function renderBoth(node: ReactNode) {
  const html = await render(node);

  return {
    html,
    text: toPlainText(html, {
      selectors: [...plainTextSelectors, FACT_TABLE_SELECTOR],
    }),
  };
}

/**
 * The payload the row carries, if it is the kind this message expects.
 *
 * A mismatch returns null rather than throwing: the message still goes out,
 * missing one optional detail, which is strictly better than a customer never
 * being told their appointment moved because a jsonb column had the wrong
 * shape in it.
 */
function payloadOf<K extends NotificationPayload["kind"]>(
  subject: NotificationSubject,
  kind: K,
): Extract<NotificationPayload, { kind: K }> | null {
  return subject.payload?.kind === kind
    ? (subject.payload as Extract<NotificationPayload, { kind: K }>)
    : null;
}

export async function composeNotification(
  subject: NotificationSubject,
): Promise<ComposedEmail> {
  const booking = bookingViewOf(subject);
  const when = `${shortDate(subject)} at ${shortTime(subject)}`;
  const agendaUrl = `${subject.origin.replace(/\/+$/, "")}/admin/calendar`;

  switch (subject.kind) {
    case "confirmation": {
      const { html, text } = await renderBoth(BookingConfirmation({ booking }));

      return {
        subject: `Booked: ${when} — ${subject.business.name}`,
        html,
        text,
        calendar: calendarPart(subject, "REQUEST"),
      };
    }

    case "reminder": {
      const { html, text } = await renderBoth(BookingReminder({ booking }));

      return {
        subject: `Tomorrow at ${shortTime(subject)} — ${subject.business.name}`,
        html,
        text,
        calendar: null,
      };
    }

    case "reschedule": {
      const moved = payloadOf(subject, "reschedule");

      /* Without the payload there is no "was" to print, so the message falls
         back to stating the new time — which is the half that matters. */
      const previous = moved
        ? {
            startsAt: moved.previousStartsAt,
            endsAt: moved.previousEndsAt,
            timeZone: subject.business.timeZone,
            visitorTimeZone: visitorZoneFor(
              moved.previousStartsAt,
              subject.business.timeZone,
              subject.customer.timeZone,
            ),
          }
        : booking.times;

      const { html, text } = await renderBoth(
        BookingReschedule({
          booking,
          previous,
          movedBy: moved?.movedBy ?? "business",
        }),
      );

      return {
        subject: `Moved: now ${when} — ${subject.business.name}`,
        html,
        text,
        /* SAME UID, HIGHER SEQUENCE. This is the message that makes a calendar
           move an event instead of growing a duplicate. */
        calendar: calendarPart(subject, "REQUEST"),
      };
    }

    case "cancellation": {
      const { html, text } = await renderBoth(
        BookingCancellation({
          booking,
          cancelledBy: subject.appointment.cancelledBy ?? "business",
          reason: subject.appointment.cancellationReason,
          refundedCents: subject.appointment.refundedCents,
          rebookUrl: `${subject.origin.replace(/\/+$/, "")}${bookingUrl(
            subject.business.slug,
            { service: subject.service.id },
          )}`,
        }),
      );

      return {
        subject: `Cancelled: ${when} — ${subject.business.name}`,
        html,
        text,
        /* CANCEL, and nothing else in the message. A cancellation delivered
           alongside a still-valid REQUEST is filed by half the clients in the
           world as "still going ahead". */
        calendar: calendarPart(subject, "CANCEL"),
      };
    }

    case "new_booking": {
      const { html, text } = await renderBoth(
        NewBooking({ booking, agendaUrl }),
      );

      return {
        subject: `New booking: ${subject.customer.name}, ${when}`,
        html,
        text,
        calendar: null,
      };
    }

    case "slot_lost": {
      const lost = payloadOf(subject, "slot_lost");
      const refundedCents =
        lost?.refundedCents ?? subject.appointment.refundedCents ?? 0;
      const origin = subject.origin.replace(/\/+$/, "");

      const rebookUrl = `${origin}${
        lost?.rebookPath ??
        bookingUrl(subject.business.slug, { service: subject.service.id })
      }`;

      const { html, text } = await renderBoth(
        SlotLost({
          booking,
          refundedCents,
          alternatives: (lost?.alternatives ?? []).map((option) => ({
            startsAt: option.startsAt,
            endsAt: option.endsAt,
            /* Deep-linked at the DAY, not the minute. A link that reserved the
               slot on click would hand a hold to whoever opened the email
               first, including a mail client prefetching links. */
            url: `${origin}${bookingUrl(subject.business.slug, {
              service: subject.service.id,
              date: formatInstant(
                option.startsAt,
                subject.business.timeZone,
                { year: "numeric", month: "2-digit", day: "2-digit" },
                "en-CA",
              ),
            })}`,
          })),
          rebookUrl,
        }),
      );

      return {
        subject: `That time went — ${formatCents(
          refundedCents,
          subject.business.currency,
        )} refunded`,
        html,
        text,
        calendar: null,
      };
    }

    case "refund": {
      const refund = payloadOf(subject, "refund");
      const refundedCents =
        refund?.refundedCents ?? subject.appointment.refundedCents ?? 0;

      const { html, text } = await renderBoth(
        RefundNotice({
          booking,
          refundedCents,
          full: refund?.full ?? false,
          chargeId: refund?.chargeId ?? "unknown",
          agendaUrl,
        }),
      );

      return {
        subject: `Refunded ${formatCents(
          refundedCents,
          subject.business.currency,
        )} to ${subject.customer.name}`,
        html,
        text,
        calendar: null,
      };
    }
  }
}

/**
 * A one-line description of the message, for the console mailer and the log.
 *
 * Exported because the worker logs what it sent and the .ics route names what
 * it served, and both should read the same.
 */
export function describeNotification(subject: NotificationSubject): string {
  return `${subject.kind} for ${formatInstantRange(
    subject.appointment.startsAt.toISOString(),
    subject.appointment.endsAt.toISOString(),
    subject.business.timeZone,
  )} (${subject.business.timeZone})`;
}
