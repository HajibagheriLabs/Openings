import { describe, expect, it } from "vitest";

import { composeNotification } from "@/lib/notifications/compose";
import type { NotificationKind } from "@/db/schema";

import { subjectFor } from "../helpers/notification";

/**
 * Every template, rendered, and asserted on the facts that matter.
 *
 * NO DATABASE, NO NETWORK, NO MAIL CLIENT. `composeNotification` is pure: it
 * takes an appointment and returns a subject line, HTML, a plain-text part and
 * at most one calendar part. So the questions a person would otherwise answer
 * by squinting at a preview — does the confirmation state the time in the
 * business's zone, does the owner's copy carry the customer's phone number,
 * does the cancellation avoid attaching a live invitation — are answered here
 * instead, in a second.
 *
 * The fixture is in ./helpers/notification.ts: 14:00–15:30 Europe/Berlin,
 * a customer in New York, a part-paid deposit, and a note.
 */

const EVERY_KIND: NotificationKind[] = [
  "confirmation",
  "reminder",
  "reschedule",
  "cancellation",
  "new_booking",
  "slot_lost",
  "refund",
  "owner_reschedule",
  "owner_cancellation",
];

describe("every template", () => {
  it("renders HTML, a plain-text part and a subject line", async () => {
    for (const kind of EVERY_KIND) {
      const message = await composeNotification(subjectFor(kind));

      expect(message.subject, kind).not.toHaveLength(0);
      expect(message.html, kind).toContain("<!DOCTYPE html");
      /* The text part is never optional — it is what spam filters read, and
         what a watch or a screen reader renders. */
      expect(message.text.length, kind).toBeGreaterThan(80);
    }
  });

  it("names the business and the service in every message", async () => {
    for (const kind of EVERY_KIND) {
      const message = await composeNotification(subjectFor(kind));

      expect(message.text, kind).toContain("Rosa's Hair Studio");
      expect(message.text, kind).toContain("Cut and colour");
    }
  });

  /**
   * The plain-text part is READ, not just carried.
   *
   * It is what spam filters score, what a watch renders and what a screen
   * reader announces. The fact panel is a table, and a table converted
   * naively collapses into "ServiceCut and colourWithRosa Meier" — technically
   * present, and useless to all three.
   */
  it("renders the fact panel as rows in the plain-text part", async () => {
    const { text } = await composeNotification(subjectFor("confirmation"));

    expect(text).toMatch(/Service\s+Cut and colour/);
    expect(text).toMatch(/Total\s+€90\.00/);
    expect(text).not.toContain("ServiceCut and colour");
  });

  /**
   * THE ATTRIBUTION RULE, ENFORCED RATHER THAN REMEMBERED.
   *
   * A transactional email and a calendar file are the two places a tool name
   * gets into a shipped product by accident — a footer nobody re-reads and a
   * PRODID nobody looks at. This asserts on the rendered output of every
   * template, including the invite, so it cannot come back.
   */
  it("credits no tooling anywhere in the output", async () => {
    const forbidden = [
      "claude",
      "anthropic",
      "openai",
      "copilot",
      "ai-generated",
      "ai assistant",
      "generated with",
      "sebbo",
      "ical-generator",
    ];

    for (const kind of EVERY_KIND) {
      const message = await composeNotification(subjectFor(kind));
      const haystack = [
        message.subject,
        message.html,
        message.text,
        message.calendar?.content ?? "",
      ]
        .join("\n")
        .toLowerCase();

      for (const term of forbidden) {
        expect(haystack, `${kind} / ${term}`).not.toContain(term);
      }
    }
  });

  /**
   * Nobody's manage token belongs in an email addressed to somebody else.
   *
   * The owner's two messages are built from the same appointment as the
   * customer's, so the link is a spread away at all times — and a manage link
   * in the business's inbox is a link that cancels a customer's appointment.
   */
  it("keeps the customer's manage link out of the owner's messages", async () => {
    for (const kind of [
      "new_booking",
      "refund",
      "owner_reschedule",
      "owner_cancellation",
    ] as const) {
      const message = await composeNotification(subjectFor(kind));

      expect(message.html, kind).not.toContain("/manage/");
      expect(message.html, kind).not.toContain("manage-token-for-tests");
    }
  });
});

describe("times", () => {
  it("states the business time first, and the customer's second", async () => {
    const { text } = await composeNotification(subjectFor("confirmation"));

    /* 12:00Z is 14:00 in Berlin and 08:00 in New York. Both appear, the
       business's labelled as business time and the customer's as theirs. */
    expect(text).toContain("14:00 – 15:30");
    expect(text).toContain("Europe/Berlin (business time)");
    expect(text).toContain("08:00 – 09:30");
    expect(text).toContain("America/New York");

    /* Order matters: quietly converting to the reader's zone is how an email,
       an invite and a shop's front door end up disagreeing. */
    expect(text.indexOf("14:00 – 15:30")).toBeLessThan(
      text.indexOf("08:00 – 09:30"),
    );
  });

  it("prints one time when the customer's zone was never captured", async () => {
    const { text } = await composeNotification(
      subjectFor("confirmation", { customer: { timeZone: null } }),
    );

    expect(text).toContain("14:00 – 15:30");
    expect(text).not.toContain("08:00 – 09:30");
  });

  it("prints one time when the two zones show the same clock", async () => {
    /* Paris and Berlin are different identifiers and identical clocks. A
       second line saying exactly the same time is noise that teaches people to
       skip the timezone line entirely. */
    const { text } = await composeNotification(
      subjectFor("confirmation", { customer: { timeZone: "Europe/Paris" } }),
    );

    expect(text).toContain("14:00 – 15:30");
    expect(text).not.toContain("Europe/Paris");
  });
});

describe("the confirmation", () => {
  it("states the appointment, the money split and the manage link", async () => {
    const message = await composeNotification(subjectFor("confirmation"));

    expect(message.subject).toBe(
      "Booked: Thu 3 Sept at 14:00 — Rosa's Hair Studio",
    );

    expect(message.text).toContain("You are booked in");
    expect(message.text).toContain("Rosa Meier");
    expect(message.text).toContain("1 hr 30 min");
    expect(message.text).toContain("Oranienstrasse 12, 10999 Berlin");

    /* Three money lines, never one: what left the account, what to bring, and
       the total. */
    expect(message.text).toContain("Deposit paid");
    expect(message.text).toContain("€20.00");
    expect(message.text).toContain("€70.00");
    expect(message.text).toContain("€90.00");

    /* THE TOKEN IS THE WHOLE ADDRESS — no appointment id in the path. A link
       pasted into a support chat leaks one fewer identifier, and the route
       hashes what it is given to find the row. */
    expect(message.html).toContain(
      "https://openings.example/manage/manage-token-for-tests",
    );
    expect(message.html).not.toContain(
      "/manage/1c0a8f2e-4b3d-4f7a-8c19-2d3e4f5a6b70",
    );
    /* The two calendar fallbacks, because attachment handling is a lottery. */
    expect(message.html).toContain("https://openings.example/ics/");
    expect(message.html).toContain("calendar.google.com");

    /* And the policy the customer ticked a box beside. */
    expect(message.text).toContain("cancel up to a day before");
  });

  it("says the deposit is due when it has not been taken", async () => {
    const message = await composeNotification(
      subjectFor("confirmation", { appointment: { depositPaid: false } }),
    );

    expect(message.text).toContain("Deposit due");
    expect(message.text).not.toContain("Deposit paid");
  });

  it("states one price when there is no deposit", async () => {
    const message = await composeNotification(
      subjectFor("confirmation", {
        appointment: { depositCents: 0, depositPaid: false },
      }),
    );

    expect(message.text).toContain("€90.00 on the day");
    expect(message.text).not.toContain("Deposit");
  });
});

describe("the reminder", () => {
  it("is short, says tomorrow, and attaches nothing", async () => {
    const message = await composeNotification(subjectFor("reminder"));

    expect(message.subject).toBe("Tomorrow at 14:00 — Rosa's Hair Studio");
    expect(message.text).toContain("Tomorrow at Rosa's Hair Studio");
    expect(message.text).toContain("14:00 – 15:30");

    /* Re-sending the same UID at the same sequence changes nothing in any
       calendar, and a second attachment tips some clients out of rendering the
       message as a message. */
    expect(message.calendar).toBeNull();
    /* The links stay, for anybody whose client swallowed the first invite. */
    expect(message.html).toContain("calendar.google.com");
  });
});

describe("the reschedule", () => {
  it("shows where it moved from and where it moved to", async () => {
    const message = await composeNotification(
      subjectFor("reschedule", {
        appointment: { icsSequence: 1 },
        payload: {
          kind: "reschedule",
          previousStartsAt: "2026-09-02T07:00:00.000Z",
          previousEndsAt: "2026-09-02T08:30:00.000Z",
          movedBy: "customer",
        },
      }),
    );

    expect(message.subject).toBe(
      "Moved: now Thu 3 Sept at 14:00 — Rosa's Hair Studio",
    );

    /* Was: 09:00–10:30 on Wednesday. Now: 14:00–15:30 on Thursday. */
    expect(message.text).toContain("09:00 – 10:30");
    expect(message.text).toContain("14:00 – 15:30");
    expect(message.text.indexOf("09:00 – 10:30")).toBeLessThan(
      message.text.indexOf("14:00 – 15:30"),
    );

    expect(message.calendar?.method).toBe("REQUEST");
  });

  it("still states the new time when the payload is missing", async () => {
    const message = await composeNotification(
      subjectFor("reschedule", { appointment: { icsSequence: 1 } }),
    );

    expect(message.text).toContain("14:00 – 15:30");
    expect(message.calendar?.method).toBe("REQUEST");
  });
});

describe("the cancellation", () => {
  it("answers the money question before anything else", async () => {
    const message = await composeNotification(
      subjectFor("cancellation", {
        appointment: {
          icsSequence: 2,
          cancelledBy: "business",
          cancellationReason: "Rosa is unwell.",
          refundedCents: 2000,
        },
      }),
    );

    expect(message.subject).toBe(
      "Cancelled: Thu 3 Sept at 14:00 — Rosa's Hair Studio",
    );

    expect(message.text).toContain("cancelled");
    expect(message.text).toContain("€20.00 has been refunded");
    expect(message.text).toContain("Rosa is unwell.");

    /* The refund line comes before the appointment details. */
    expect(message.text.indexOf("€20.00 has been refunded")).toBeLessThan(
      message.text.indexOf("Cut and colour"),
    );

    /* CANCEL, and no still-valid copy anywhere in the message. */
    expect(message.calendar?.method).toBe("CANCEL");
    expect(message.calendar?.content).not.toContain("METHOD:REQUEST");
  });

  it("says the deposit is kept when nothing was refunded", async () => {
    const message = await composeNotification(
      subjectFor("cancellation", {
        appointment: { icsSequence: 1, cancelledBy: "customer" },
      }),
    );

    expect(message.text).toContain("€20.00 deposit is not refunded");
  });
});

describe("the owner's new booking", () => {
  it("leads with the customer, not the service", async () => {
    const message = await composeNotification(subjectFor("new_booking"));

    expect(message.subject).toBe("New booking: Sam Meyer, Thu 3 Sept at 14:00");

    expect(message.text).toContain("Sam Meyer");
    expect(message.text).toContain("sam@example.com");
    expect(message.text).toContain("+1 212 555 0147");
    /* The one thing on this message the business has to read before the day. */
    expect(message.text).toContain("Growing out a fringe.");
    expect(message.html).toContain("/admin/calendar");

    /* The owner's calendar of record is the agenda, and an organizer receiving
       their own REQUEST is the case clients handle least consistently. */
    expect(message.calendar).toBeNull();
  });
});

describe("the apology", () => {
  it("leads with the refund and offers real times", async () => {
    const message = await composeNotification(
      subjectFor("slot_lost", {
        payload: {
          kind: "slot_lost",
          refundedCents: 2000,
          currency: "EUR",
          alternatives: [
            {
              startsAt: "2026-09-03T14:00:00.000Z",
              endsAt: "2026-09-03T15:30:00.000Z",
            },
            {
              startsAt: "2026-09-04T07:00:00.000Z",
              endsAt: "2026-09-04T08:30:00.000Z",
            },
          ],
          rebookPath: "/book/rosas-hair-studio?service=9a8b7c6d",
        },
      }),
    );

    expect(message.subject).toBe("That time went — €20.00 refunded");
    expect(message.text).toContain("€20.00 has been refunded in full");

    /* Specific openings, each a link. "Please try again" is a dead end. */
    expect(message.text).toContain("16:00 – 17:30");
    expect(message.text).toContain("09:00 – 10:30");
    /* Deep-linked at the DAY: a link that took the slot on click would hand a
       hold to whichever mail client prefetched it first. */
    expect(message.html).toContain("date=2026-09-04");

    expect(message.calendar).toBeNull();
  });

  it("points at the picker when nothing near is free", async () => {
    const message = await composeNotification(
      subjectFor("slot_lost", {
        payload: {
          kind: "slot_lost",
          refundedCents: 2000,
          currency: "EUR",
          alternatives: [],
          rebookPath: "/book/rosas-hair-studio",
        },
      }),
    );

    expect(message.text).toContain("nothing close to that time free");
    expect(message.html).toContain(
      "https://openings.example/book/rosas-hair-studio",
    );
  });
});

describe("the owner's refund notice", () => {
  it("says the appointment is still in the diary", async () => {
    const message = await composeNotification(
      subjectFor("refund", {
        payload: {
          kind: "refund",
          refundedCents: 2000,
          currency: "EUR",
          full: true,
          chargeId: "ch_3TestExample0001",
        },
      }),
    );

    expect(message.subject).toBe("Refunded €20.00 to Sam Meyer");
    expect(message.text).toContain("still in your diary");
    expect(message.text).toContain("ch_3TestExample0001");
    expect(message.calendar).toBeNull();
  });
});
