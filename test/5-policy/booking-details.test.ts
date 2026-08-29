import { describe, expect, it } from "vitest";

import {
  cancellationPolicyLines,
  describeCancellationWindow,
  describeDepositPolicy,
  describeReschedule,
} from "@/lib/booking/policy";
import {
  bookingDetailsSchema,
  HONEYPOT_FIELD,
} from "@/lib/validation/booking-details";

/**
 * The form's contract and the policy's words.
 *
 * Both are parsed or rendered on BOTH sides, so a change that breaks one side
 * silently breaks the other. These are the cases a real customer produces: a
 * trailing space on an email, a phone number with brackets in it, an unticked
 * box, and a business whose cancellation window is a round number of days.
 */

const valid = {
  name: "Sam Taylor",
  email: "sam@example.com",
  phone: "",
  note: "",
  policyAccepted: true as const,
};

describe("the honeypot", () => {
  /**
   * ═══ THE SCHEMA MUST *ACCEPT* A FILLED HONEYPOT ═══
   *
   * This reads backwards until you see what the alternative does. If the
   * schema refused it, the submit would come back as an ordinary validation
   * failure NAMING THE FIELD — and a trap that tells the caller which field
   * gave them away is a trap with a one-line fix.
   *
   * So parsing succeeds and the server refuses afterwards, with the same
   * message a rate-limited human gets. This test exists to stop somebody
   * "tidying up" the schema by adding the `.max(0)` that looks missing.
   */
  it("PARSES A FILLED HONEYPOT INSTEAD OF NAMING IT IN AN ERROR", () => {
    const result = bookingDetailsSchema.safeParse({
      ...valid,
      [HONEYPOT_FIELD]: "Acme Ltd",
    });

    expect(result.success).toBe(true);
    expect(result.data?.company).toBe("Acme Ltd");

    /* And nothing anywhere in the issues may mention the field, on any input. */
    const rejected = bookingDetailsSchema.safeParse({
      ...valid,
      name: "",
      [HONEYPOT_FIELD]: "Acme Ltd",
    });

    expect(
      rejected.error?.issues.some((issue) => issue.path[0] === HONEYPOT_FIELD),
    ).toBe(false);
  });

  it("defaults to empty, so an untouched form always passes the server's check", () => {
    expect(bookingDetailsSchema.parse(valid).company).toBe("");
  });
});

describe("bookingDetailsSchema", () => {
  it("accepts the minimum a booking actually needs", () => {
    const parsed = bookingDetailsSchema.parse(valid);

    expect(parsed.name).toBe("Sam Taylor");
    expect(parsed.email).toBe("sam@example.com");
    expect(parsed.phone).toBe("");
    expect(parsed.note).toBe("");
  });

  it("trims and lowercases the email so dedupe cannot miss", () => {
    /* `customers` is unique on (business_id, email). "Sam@Example.com " and
       "sam@example.com" are one person, and the schema is where they become
       one string — otherwise the unique index would happily hold both. */
    const parsed = bookingDetailsSchema.parse({
      ...valid,
      email: "  Sam@Example.COM ",
    });

    expect(parsed.email).toBe("sam@example.com");
  });

  it("trims the name rather than refusing it", () => {
    expect(bookingDetailsSchema.parse({ ...valid, name: "  Sam  " }).name).toBe(
      "Sam",
    );
  });

  it("refuses an address with no @ in it", () => {
    const result = bookingDetailsSchema.safeParse({
      ...valid,
      email: "sam.example.com",
    });

    expect(result.success).toBe(false);
  });

  it("accepts a phone number written the way people write them", () => {
    for (const phone of [
      "07700 900123",
      "+44 7700 900123",
      "(020) 7946-0000",
      "020/7946 0000",
    ]) {
      expect(bookingDetailsSchema.safeParse({ ...valid, phone }).success).toBe(
        true,
      );
    }
  });

  it("keeps the phone optional", () => {
    expect(bookingDetailsSchema.safeParse({ ...valid, phone: "" }).success).toBe(
      true,
    );

    const { phone, ...withoutPhone } = valid;
    void phone;

    expect(bookingDetailsSchema.safeParse(withoutPhone).success).toBe(true);
  });

  it("refuses letters in the phone field", () => {
    expect(
      bookingDetailsSchema.safeParse({ ...valid, phone: "call me" }).success,
    ).toBe(false);
  });

  it("REFUSES AN UNTICKED CONSENT BOX", () => {
    /* The one field that cannot be defaulted. An unticked box is not a value
       to record; it is a form that has not been completed. */
    const result = bookingDetailsSchema.safeParse({
      ...valid,
      policyAccepted: false,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["policyAccepted"]);
  });

  it("caps the note rather than truncating it silently", () => {
    const result = bookingDetailsSchema.safeParse({
      ...valid,
      note: "x".repeat(501),
    });

    expect(result.success).toBe(false);
  });

  it("reports one issue per field, so each message has a home", () => {
    const result = bookingDetailsSchema.safeParse({
      name: "",
      email: "nope",
      phone: "call me",
      note: "",
      policyAccepted: false,
    });

    const fields = new Set(result.error?.issues.map((issue) => issue.path[0]));

    expect(fields).toEqual(
      new Set(["name", "email", "phone", "policyAccepted"]),
    );
  });
});

describe("the cancellation policy, in words", () => {
  it("says days when the window is a round number of them", () => {
    expect(describeCancellationWindow(24)).toContain("a day before");
    expect(describeCancellationWindow(48)).toContain("2 days before");
  });

  it("says hours when it is not", () => {
    expect(describeCancellationWindow(4)).toContain("4 hours before");
    expect(describeCancellationWindow(1)).toContain("an hour before");
  });

  it("says the generous thing when there is no window at all", () => {
    expect(describeCancellationWindow(0)).toBe(
      "You can cancel any time before your appointment.",
    );
  });

  it("mentions the deposit only when there is one", () => {
    expect(describeDepositPolicy(0)).toBeNull();
    expect(describeDepositPolicy(1500)).toContain("not refunded");
  });

  it("says whether the customer can move it themselves", () => {
    expect(describeReschedule(true)).toContain("confirmation email");
    expect(describeReschedule(false)).toContain("get in touch");
  });

  it("drops the deposit line from the consent text for a free service", () => {
    const free = cancellationPolicyLines({
      cancellationWindowHours: 24,
      allowReschedule: true,
      depositCents: 0,
    });

    const paid = cancellationPolicyLines({
      cancellationWindowHours: 24,
      allowReschedule: true,
      depositCents: 1500,
    });

    expect(free).toHaveLength(2);
    expect(paid).toHaveLength(3);
    expect(free.join(" ")).not.toContain("deposit");
  });
});
