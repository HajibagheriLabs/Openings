import { describe, expect, it } from "vitest";

import { composeNotification } from "@/lib/notifications/compose";
import { ICS_PRODID } from "@/lib/notifications/invite";

import { ICS_UID, subjectFor } from "./helpers/notification";

/**
 * The invite lifecycle, parsed rather than eyeballed.
 *
 * These four properties are what separate a calendar invitation that works
 * from one that quietly does the wrong thing, and none of them is visible when
 * you look at an email:
 *
 *   UID       stable for the appointment's whole life. A reschedule that
 *             invented a new one would leave the OLD event in the customer's
 *             calendar forever, and they would turn up at the old time.
 *   SEQUENCE  0 at confirmation, higher on every change. A moved appointment
 *             at an unchanged sequence is silently discarded by the client,
 *             which looks exactly like the email never arrived.
 *   METHOD    REQUEST for new or changed, CANCEL for withdrawn. It is what
 *             makes a mail client render an invitation rather than a file.
 *   ORGANIZER the business; ATTENDEE the customer. Reversed, the customer's
 *             calendar thinks they own the event and asks them to RSVP to
 *             their own appointment.
 *
 * So the test walks one appointment through book → move → cancel and asserts
 * all four on each transition.
 */

/* ===========================================================================
   A very small iCalendar reader
   =========================================================================== */

/**
 * Unfold, then split each content line on its first colon.
 *
 * RFC 5545 folds long lines by inserting CRLF followed by a single space or
 * tab; rejoining them is the first thing any reader has to do, and skipping it
 * is why "the UID does not match" so often turns out to mean "the UID was 78
 * characters long".
 */
function parseIcs(text: string): Map<string, string[]> {
  const unfolded = text.replace(/\r\n[ \t]/g, "");
  const properties = new Map<string, string[]>();

  for (const line of unfolded.split(/\r\n|\n/)) {
    const colon = line.indexOf(":");

    if (colon === -1) {
      continue;
    }

    /* Everything before the first `;` is the property name; parameters follow
       it. `ORGANIZER;CN="Rosa":mailto:…` is one ORGANIZER. */
    const head = line.slice(0, colon);
    const name = head.split(";")[0].toUpperCase();
    const value = line.slice(colon + 1);

    properties.set(name, [...(properties.get(name) ?? []), value]);
  }

  return properties;
}

/** The whole line including its parameters, for asserting on CN= and PARTSTAT. */
function rawLine(text: string, name: string): string {
  const unfolded = text.replace(/\r\n[ \t]/g, "");

  return (
    unfolded
      .split(/\r\n|\n/)
      .find((line) => line.toUpperCase().startsWith(`${name}`)) ?? ""
  );
}

function one(text: string, name: string): string {
  const values = parseIcs(text).get(name);

  expect(values, `${name} should appear exactly once`).toHaveLength(1);

  return values![0];
}

/* ===========================================================================
   The three transitions
   =========================================================================== */

async function inviteFor(kind: "confirmation" | "reschedule" | "cancellation") {
  const sequence = { confirmation: 0, reschedule: 1, cancellation: 2 }[kind];

  const message = await composeNotification(
    subjectFor(kind, {
      appointment: {
        icsSequence: sequence,
        ...(kind === "cancellation"
          ? { cancelledBy: "customer" as const }
          : {}),
      },
      ...(kind === "reschedule"
        ? {
            payload: {
              kind: "reschedule" as const,
              previousStartsAt: "2026-09-02T07:00:00.000Z",
              previousEndsAt: "2026-09-02T08:30:00.000Z",
              movedBy: "customer" as const,
            },
          }
        : {}),
    }),
  );

  expect(message.calendar, `${kind} must carry a calendar part`).not.toBeNull();

  return message.calendar!;
}

describe("the invite lifecycle", () => {
  it("keeps ONE UID from confirmation to cancellation", async () => {
    const book = await inviteFor("confirmation");
    const move = await inviteFor("reschedule");
    const drop = await inviteFor("cancellation");

    expect(one(book.content, "UID")).toBe(ICS_UID);
    expect(one(move.content, "UID")).toBe(ICS_UID);
    expect(one(drop.content, "UID")).toBe(ICS_UID);
  });

  it("increments SEQUENCE on every change", async () => {
    expect(one((await inviteFor("confirmation")).content, "SEQUENCE")).toBe("0");
    expect(one((await inviteFor("reschedule")).content, "SEQUENCE")).toBe("1");
    expect(one((await inviteFor("cancellation")).content, "SEQUENCE")).toBe("2");
  });

  it("uses REQUEST to book and to move, CANCEL to withdraw", async () => {
    const book = await inviteFor("confirmation");
    const move = await inviteFor("reschedule");
    const drop = await inviteFor("cancellation");

    expect(one(book.content, "METHOD")).toBe("REQUEST");
    expect(one(move.content, "METHOD")).toBe("REQUEST");
    expect(one(drop.content, "METHOD")).toBe("CANCEL");

    /* The method also has to reach the MIME type, or clients treat the part as
       a file and never offer to add it. */
    expect(book.contentType).toBe("text/calendar; charset=utf-8; method=REQUEST");
    expect(drop.contentType).toBe("text/calendar; charset=utf-8; method=CANCEL");
  });

  it("marks the cancelled event CANCELLED and nothing else", async () => {
    const drop = await inviteFor("cancellation");

    expect(one(drop.content, "STATUS")).toBe("CANCELLED");
    /* No still-valid copy anywhere in the message: a cancellation delivered
       alongside a live REQUEST is filed by half the clients in the world as
       "still going ahead". */
    expect(drop.content).not.toContain("METHOD:REQUEST");
    expect(drop.content).not.toContain("STATUS:CONFIRMED");
  });

  it("moves the times rather than adding a second event", async () => {
    const move = await inviteFor("reschedule");

    /* One VEVENT, at the new instant, under the old UID. That combination is
       precisely what makes a calendar move an appointment. */
    expect(move.content.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(one(move.content, "DTSTART")).toBe("20260903T120000Z");
    expect(one(move.content, "DTEND")).toBe("20260903T133000Z");
    expect(one(move.content, "UID")).toBe(ICS_UID);
  });
});

describe("the invite's contents", () => {
  it("writes every instant in UTC, with no VTIMEZONE", async () => {
    const { content } = await inviteFor("confirmation");

    /* An instant is an instant. Writing it in UTC means no client has to agree
       with us about what "Europe/Berlin" meant on that date, and no timezone
       definition has to travel with the message. */
    expect(one(content, "DTSTART")).toBe("20260903T120000Z");
    expect(one(content, "DTEND")).toBe("20260903T133000Z");
    expect(one(content, "DTSTAMP")).toBe("20260828T090000Z");
    expect(content).not.toContain("BEGIN:VTIMEZONE");
    expect(content).not.toContain("TZID");
  });

  it("makes the business the organizer and the customer the attendee", async () => {
    const { content } = await inviteFor("confirmation");

    const organizer = rawLine(content, "ORGANIZER");
    const attendee = rawLine(content, "ATTENDEE");

    expect(organizer).toContain("hello@rosas.example");
    expect(organizer).toContain("Rosa's Hair Studio");

    expect(attendee).toContain("sam@example.com");
    expect(attendee).toContain("Sam Meyer");

    /* ACCEPTED and RSVP=FALSE: they booked this themselves and paid a deposit
       for it. Asking them to reply to their own appointment produces a stream
       of declines that mean nothing. */
    expect(attendee).toContain("PARTSTAT=ACCEPTED");
    expect(attendee).toContain("RSVP=FALSE");
  });

  it("carries the manage link, the location and one service in the summary", async () => {
    const { content } = await inviteFor("confirmation");

    expect(one(content, "SUMMARY")).toBe(
      "Cut and colour — Rosa's Hair Studio",
    );
    expect(one(content, "LOCATION")).toContain("Oranienstrasse 12");

    /* A calendar entry is where somebody looks when they realise they cannot
       make it — not their inbox, and not a confirmation they archived weeks
       ago. So the link has to be in the event itself. */
    expect(one(content, "DESCRIPTION")).toContain(
      "https://openings.example/manage/",
    );
    expect(one(content, "URL")).toContain("https://openings.example/manage/");
  });

  it("names this product in PRODID and no tool at all", async () => {
    const { content, filename } = await inviteFor("confirmation");

    expect(one(content, "PRODID")).toBe("-//Openings//Booking//EN");
    expect(ICS_PRODID).toBe("-//Openings//Booking//EN");

    /* The library's default PRODID carries its author's name. Leaving it would
       put somebody else's brand inside every customer's calendar. */
    expect(content.toLowerCase()).not.toContain("sebbo");
    expect(content.toLowerCase()).not.toContain("ical-generator");

    expect(filename).toBe("invite.ics");
  });

  it("is a well-formed, folded iCalendar object", async () => {
    const { content } = await inviteFor("confirmation");

    expect(content.startsWith("BEGIN:VCALENDAR")).toBe(true);
    expect(content.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(one(content, "VERSION")).toBe("2.0");

    /* CRLF, as the format requires. Plenty of parsers accept bare LF; Outlook
       is not reliably one of them. */
    expect(content).toContain("\r\n");

    /* No content line may exceed 75 octets before folding. */
    for (const line of content.split("\r\n")) {
      expect(Buffer.byteLength(line, "utf8"), line).toBeLessThanOrEqual(75);
    }
  });
});
