import { describe, expect, it } from "vitest";

import {
  DEFAULT_REMINDER_LEAD_MIN,
  describeReminderLead,
  reminderInstantFor,
} from "@/lib/notifications/reminder";
import { isLocalOrigin } from "@/lib/notifications/scheduler";
import { REMINDER_LEAD_OPTIONS } from "@/lib/validation/notifications";

/**
 * When a reminder goes out, whether it goes out at all, and whether anything
 * can be scheduled to deliver it.
 *
 * All three are pure decisions, and all three have a failure mode a customer
 * would feel: a reminder about an appointment that already happened, a
 * duplicate confirmation a minute after the real one, or a message published
 * to an address nobody can reach.
 */

const NOW = new Date("2026-09-01T09:00:00Z");

describe("when a reminder is due", () => {
  it("counts back from the appointment by the business's lead time", () => {
    const at = reminderInstantFor({
      startsAt: new Date("2026-09-10T14:00:00Z"),
      reminderLeadMin: DEFAULT_REMINDER_LEAD_MIN,
      now: NOW,
    });

    expect(at?.toISOString()).toBe("2026-09-09T14:00:00.000Z");
  });

  it("honours a business that reminds two hours ahead", () => {
    const at = reminderInstantFor({
      startsAt: new Date("2026-09-10T14:00:00Z"),
      reminderLeadMin: 120,
      now: NOW,
    });

    expect(at?.toISOString()).toBe("2026-09-10T12:00:00.000Z");
  });

  /**
   * THE CASE THE WHOLE HELPER EXISTS FOR.
   *
   * Somebody books at 9am for 11am the same day, at a business that reminds a
   * day ahead. The reminder's moment was yesterday. Writing that row would
   * queue a message the outbox reads as overdue and delivers IMMEDIATELY — a
   * "your appointment is tomorrow" email arriving one minute after the
   * confirmation, for an appointment two hours away.
   */
  it("gives NO reminder for a booking made inside the window", () => {
    expect(
      reminderInstantFor({
        startsAt: new Date("2026-09-01T11:00:00Z"),
        reminderLeadMin: DEFAULT_REMINDER_LEAD_MIN,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("gives no reminder when the moment is exactly now", () => {
    /* A boundary, and the answer has to be "no": a reminder due this instant
       is a second confirmation. */
    expect(
      reminderInstantFor({
        startsAt: new Date("2026-09-02T09:00:00Z"),
        reminderLeadMin: DEFAULT_REMINDER_LEAD_MIN,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("gives a reminder a minute the other side of the boundary", () => {
    const at = reminderInstantFor({
      startsAt: new Date("2026-09-02T09:01:00Z"),
      reminderLeadMin: DEFAULT_REMINDER_LEAD_MIN,
      now: NOW,
    });

    expect(at?.toISOString()).toBe("2026-09-01T09:01:00.000Z");
  });

  /**
   * Minutes are a count, not a clock, so this is plain subtraction — and it
   * has to stay that way. The appointment is an instant and the lead time is a
   * duration; neither is a wall-clock date, so no timezone enters into it and
   * a DST transition between now and then cannot move the reminder.
   */
  it("is unaffected by a DST transition in between", () => {
    /* Europe/Berlin loses an hour on 29 March 2026. Both instants are UTC, and
       the gap between them is exactly 24 hours regardless. */
    const at = reminderInstantFor({
      startsAt: new Date("2026-03-29T09:00:00Z"),
      reminderLeadMin: DEFAULT_REMINDER_LEAD_MIN,
      now: new Date("2026-03-01T00:00:00Z"),
    });

    expect(at?.toISOString()).toBe("2026-03-28T09:00:00.000Z");
  });
});

describe("the lead time in words", () => {
  it("says days, hours and minutes the way a person would", () => {
    expect(describeReminderLead(24 * 60)).toBe("a day before");
    expect(describeReminderLead(48 * 60)).toBe("2 days before");
    expect(describeReminderLead(60)).toBe("an hour before");
    expect(describeReminderLead(180)).toBe("3 hours before");
    expect(describeReminderLead(45)).toBe("45 minutes before");
  });

  it("says the same thing the settings form says", () => {
    /* The form offers a label and the save confirmation describes what was
       chosen. Two wordings for one setting is how an owner ends up unsure
       whether their change took. */
    for (const option of REMINDER_LEAD_OPTIONS) {
      expect(
        describeReminderLead(option.minutes).toLowerCase(),
        option.label,
      ).toBe(option.label.toLowerCase());
    }
  });
});

describe("whether the delivery service can reach us", () => {
  /**
   * QStash delivers by making an HTTP request. A message published against
   * localhost is accepted, retried against nothing, and lands in a dead letter
   * queue — which looks exactly like a broken product to somebody running the
   * repository for the first time, and costs them their quota to find out.
   */
  it("refuses to schedule against an address only this machine can see", () => {
    expect(isLocalOrigin("http://localhost:3000")).toBe(true);
    expect(isLocalOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(isLocalOrigin("http://app.localhost:3000")).toBe(true);
    expect(isLocalOrigin("not a url at all")).toBe(true);
  });

  it("schedules against a real origin", () => {
    expect(isLocalOrigin("https://openings.example")).toBe(false);
    expect(isLocalOrigin("https://openings.example/")).toBe(false);
    /* A tunnel is the documented way to exercise the real path locally. */
    expect(isLocalOrigin("https://openings.ngrok.app")).toBe(false);
  });
});
