import ical, {
  ICalAttendeeRole,
  ICalAttendeeStatus,
  ICalCalendarMethod,
  ICalEventStatus,
} from "ical-generator";

import { APP_NAME } from "@/lib/brand";

/**
 * The calendar invite — the part of a booking product that almost everybody
 * gets wrong, and the reason this module is longer than it looks like it
 * should be.
 *
 * FOUR RULES, AND ALL FOUR ARE LOAD-BEARING:
 *
 *   1. ONE UID PER APPOINTMENT, FOR ITS WHOLE LIFE. `appointments.ics_uid` is
 *      minted once, when the row is first written, and never changes. A
 *      reschedule that invented a new UID would not move the customer's event
 *      — it would add a second one and leave the first sitting in their
 *      calendar forever, and they would arrive at the old time.
 *
 *   2. SEQUENCE STARTS AT 0 AND INCREMENTS ON EVERY CHANGE. It is how a client
 *      decides whether an incoming copy is newer than the one it already has.
 *      A re-sent invite at the same sequence is legitimately ignored; a moved
 *      appointment at the same sequence is silently discarded, which looks
 *      exactly like the email never arrived.
 *
 *   3. METHOD:REQUEST FOR A NEW OR CHANGED BOOKING, METHOD:CANCEL FOR A
 *      CANCELLATION. The method is what makes a mail client render an
 *      invitation with buttons rather than an attachment with a paperclip. A
 *      cancellation carries CANCEL plus STATUS:CANCELLED and NO second,
 *      still-valid copy of the event anywhere in the message — see
 *      `INVITE_FILENAME` below.
 *
 *   4. ORGANIZER IS THE BUSINESS, ATTENDEE IS THE CUSTOMER. Reversing them
 *      makes the customer's own calendar think they own the event and hands
 *      them an RSVP for a meeting they arranged.
 *
 * WHY EVERY TIME IS WRITTEN IN UTC. `Date` objects go out as `...Z` instants,
 * so no VTIMEZONE block is needed and no client has to agree with us about
 * what "Europe/Berlin" meant on a given date. The appointment is an instant;
 * the business's local wall clock is a presentation concern and it belongs in
 * the SUMMARY and the email body, not in the event's start time.
 *
 * This module is PURE — no configuration, no database, no `server-only`. It
 * takes facts and returns a string, which is what makes the .ics output
 * assertable in a test rather than something to be eyeballed in a mail client.
 */

/** New or changed booking, versus withdrawn. */
export type InviteMethod = "REQUEST" | "CANCEL";

export interface InviteInput {
  method: InviteMethod;
  /** `appointments.ics_uid`. Stable for the appointment's whole life. */
  uid: string;
  /** `appointments.ics_sequence`. 0 at confirmation, +1 on every change. */
  sequence: number;
  startsAt: Date;
  endsAt: Date;
  /** "Cut and colour — Rosa's Hair Studio". What shows in the calendar grid. */
  summary: string;
  /** Plain text. Carries the manage link, because a calendar entry is where
   *  somebody looks when they need to change something. */
  description: string;
  /** The business's street address, or null when it has none on file. */
  location: string | null;
  organizer: { name: string; email: string };
  attendee: { name: string; email: string };
  /** The manage link again, as the event's URL property. */
  url: string;
  /**
   * DTSTAMP — when this copy of the event was produced.
   *
   * Injectable so a test can assert byte-for-byte on everything else. Defaults
   * to now, which is what it means in production.
   */
  stamp?: Date;
}

/**
 * The filename on the single calendar part.
 *
 * `invite.ics` rather than anything descriptive, because some clients show the
 * filename instead of rendering the invitation and "invite.ics" at least reads
 * as what it is. ONE part per message, always — a second attachment is what
 * tips Gmail and Outlook out of invitation rendering and into showing a
 * paperclip, and a cancellation that still carries the old REQUEST alongside
 * it will be filed by half the clients in the world as "still going ahead".
 */
export const INVITE_FILENAME = "invite.ics";

/**
 * The MIME type for the calendar part, including the method.
 *
 * The `method=` parameter is not decoration: a `text/calendar` part without it
 * is treated as a plain file by most clients, and the whole point of sending
 * one is that it is not.
 */
export function inviteContentType(method: InviteMethod): string {
  return `text/calendar; charset=utf-8; method=${method}`;
}

/**
 * PRODID — who made this file.
 *
 * The product's name and nothing else. No toolchain, no generator, no library
 * banner: this string ships inside every customer's calendar and is part of
 * the product's surface exactly like the footer of an email is. The library's
 * own default would put ITS name here, which is why it is set explicitly.
 *
 * Given as company/product rather than as a finished string because
 * ical-generator writes the leading `-` itself; handing it a string starting
 * with `-//` yields `PRODID:--//…`, which is malformed and which nothing warns
 * about.
 */
const PRODID_PARTS = { company: APP_NAME, product: "Booking", language: "EN" };

/** The exact PRODID line value the files below carry. Asserted in the tests. */
export const ICS_PRODID = `-//${PRODID_PARTS.company}//${PRODID_PARTS.product}//${PRODID_PARTS.language}`;

/** The iCalendar text for one appointment, ready to attach or to serve. */
export function buildInvite(input: InviteInput): string {
  const cancelling = input.method === "CANCEL";

  const calendar = ical({
    prodId: PRODID_PARTS,
    method:
      input.method === "CANCEL"
        ? ICalCalendarMethod.CANCEL
        : ICalCalendarMethod.REQUEST,
    /* No calendar-level NAME. This is a message about one event, not a
       subscribable feed, and a name makes some clients offer to add a whole
       calendar rather than the appointment. */
    events: [
      {
        id: input.uid,
        sequence: input.sequence,
        start: input.startsAt,
        end: input.endsAt,
        stamp: input.stamp ?? new Date(),
        summary: input.summary,
        description: input.description,
        location: input.location ?? undefined,
        url: input.url,
        organizer: {
          name: input.organizer.name,
          email: input.organizer.email,
        },
        attendees: [
          {
            name: input.attendee.name,
            email: input.attendee.email,
            role: ICalAttendeeRole.REQ,
            /**
             * ACCEPTED, and RSVP off.
             *
             * The customer did not receive an invitation to consider — they
             * booked it themselves and paid a deposit for it. Sending
             * NEEDS-ACTION would make their calendar ask them to reply to
             * their own appointment, and a business that gets a stream of
             * "declined" replies from people who simply dismissed a prompt
             * learns nothing true from them.
             */
            status: cancelling
              ? ICalAttendeeStatus.DECLINED
              : ICalAttendeeStatus.ACCEPTED,
            rsvp: false,
          },
        ],
        /* CONFIRMED or CANCELLED. Together with METHOD this is what tells a
           calendar to strike the event through rather than leave it. */
        status: cancelling
          ? ICalEventStatus.CANCELLED
          : ICalEventStatus.CONFIRMED,
      },
    ],
  });

  return calendar.toString();
}
