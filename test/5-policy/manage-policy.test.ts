import { describe, expect, it } from "vitest";

import {
  cancellationTiming,
  describeCancellationOutcome,
  describeNotice,
  managePermissions,
  manageTokenExpiresAt,
  MANAGE_TOKEN_TTL_DAYS,
} from "@/lib/booking/manage-policy";

/**
 * What a customer may do to their own appointment, and how long their link
 * lasts.
 *
 * Pure decisions with real consequences: getting the window backwards would
 * mean refusing every in-time cancellation and permitting every late one, and
 * the money sentence being wrong is somebody discovering after the fact that
 * their deposit is gone.
 */

const NOW = new Date("2026-09-01T12:00:00Z");

/** Every fact `managePermissions` needs, with the interesting one overridable. */
function policy(overrides: Partial<Parameters<typeof managePermissions>[0]> = {}) {
  return managePermissions({
    status: "confirmed",
    startsAt: new Date("2026-09-05T10:00:00Z"),
    cancellationWindowHours: 24,
    allowReschedule: true,
    contactPhone: "+49 30 1234 5678",
    now: NOW,
    ...overrides,
  });
}

describe("the cancellation window", () => {
  it("is in time while the appointment is further away than the notice", () => {
    expect(
      cancellationTiming({
        startsAt: new Date("2026-09-03T12:00:00Z"),
        cancellationWindowHours: 24,
        now: NOW,
      }),
    ).toBe("in-time");
  });

  it("is late once the appointment is closer than the notice", () => {
    expect(
      cancellationTiming({
        startsAt: new Date("2026-09-02T06:00:00Z"),
        cancellationWindowHours: 24,
        now: NOW,
      }),
    ).toBe("late");
  });

  /**
   * THE BOUNDARY, and it is generous on purpose.
   *
   * Exactly 24 hours' notice IS 24 hours' notice. A business asking for a day
   * has been given a day, and refusing on the tick would be a rule nobody
   * could have read off the sentence they agreed to.
   */
  it("counts exactly the notice asked for as in time", () => {
    expect(
      cancellationTiming({
        startsAt: new Date("2026-09-02T12:00:00Z"),
        cancellationWindowHours: 24,
        now: NOW,
      }),
    ).toBe("in-time");
  });

  it("is late one second inside the boundary", () => {
    expect(
      cancellationTiming({
        startsAt: new Date("2026-09-02T11:59:59Z"),
        cancellationWindowHours: 24,
        now: NOW,
      }),
    ).toBe("late");
  });

  it("treats an appointment that has started as past, not late", () => {
    expect(
      cancellationTiming({
        startsAt: new Date("2026-09-01T11:00:00Z"),
        cancellationWindowHours: 24,
        now: NOW,
      }),
    ).toBe("past");
  });

  it("lets a business ask for no notice at all", () => {
    expect(
      cancellationTiming({
        startsAt: new Date("2026-09-01T12:00:01Z"),
        cancellationWindowHours: 0,
        now: NOW,
      }),
    ).toBe("in-time");
  });
});

describe("what the customer may do", () => {
  it("allows both when there is time and the business permits it", () => {
    const permissions = policy();

    expect(permissions).toMatchObject({
      isLive: true,
      canReschedule: true,
      canCancel: true,
      rescheduleRefusal: null,
      cancelRefusal: null,
    });
  });

  /**
   * MOVING AND CANCELLING SHARE THE WINDOW.
   *
   * Otherwise the whole policy is walked around by moving the appointment to
   * next month and cancelling it from there, which is the first thing anybody
   * tries.
   */
  it("refuses BOTH when the change is late, and says why with a number", () => {
    const permissions = policy({
      startsAt: new Date("2026-09-02T06:00:00Z"),
    });

    expect(permissions.canReschedule).toBe(false);
    expect(permissions.canCancel).toBe(false);
    expect(permissions.cancelRefusal).toContain("less than a day");
    /* A refusal with no next step is a dead end. The next step is a person. */
    expect(permissions.cancelRefusal).toContain("+49 30 1234 5678");
  });

  it("offers to get in touch when the business has no phone number", () => {
    const permissions = policy({
      startsAt: new Date("2026-09-02T06:00:00Z"),
      contactPhone: null,
    });

    expect(permissions.cancelRefusal).toContain("Get in touch");
    expect(permissions.cancelRefusal).not.toContain("ring");
  });

  /**
   * `allow_reschedule` is the harder switch: off means no moving at any
   * notice, and it must not quietly take cancelling with it.
   */
  it("keeps cancelling available when only reschedule is turned off", () => {
    const permissions = policy({ allowReschedule: false });

    expect(permissions.canReschedule).toBe(false);
    expect(permissions.canCancel).toBe(true);
    expect(permissions.rescheduleRefusal).toContain("does not take changes");
    expect(permissions.cancelRefusal).toBeNull();
  });

  it("refuses everything on an appointment that is already cancelled", () => {
    const permissions = policy({ status: "cancelled" });

    expect(permissions.isLive).toBe(false);
    expect(permissions.canCancel).toBe(false);
    expect(permissions.cancelRefusal).toContain("already cancelled");
  });

  it("refuses everything on one that has already happened", () => {
    expect(policy({ status: "completed" }).cancelRefusal).toContain(
      "already happened",
    );
    expect(policy({ status: "no_show" }).cancelRefusal).toContain(
      "already happened",
    );
  });

  it("refuses everything once the appointment has started", () => {
    const permissions = policy({
      startsAt: new Date("2026-09-01T11:00:00Z"),
    });

    expect(permissions.canCancel).toBe(false);
    expect(permissions.cancelRefusal).toContain("already started");
  });
});

describe("the notice, in words", () => {
  it("says days, hours and minutes the way a person would", () => {
    expect(describeNotice(24)).toBe("a day");
    expect(describeNotice(48)).toBe("2 days");
    expect(describeNotice(1)).toBe("an hour");
    expect(describeNotice(6)).toBe("6 hours");
    expect(describeNotice(0)).toBe("any time");
  });
});

describe("what happens to the deposit", () => {
  /**
   * THE SENTENCE IS SHOWN BEFORE THE BUTTON, and it has to be right, because
   * it is the last thing a customer reads before deciding.
   */
  it("promises the refund when the policy gives it back", () => {
    expect(
      describeCancellationOutcome({
        depositCents: 2000,
        depositPaid: true,
        refundDepositOnCancel: true,
        depositLabel: "€20.00",
      }),
    ).toContain("goes back to the card");
  });

  it("says plainly when the deposit is kept", () => {
    const sentence = describeCancellationOutcome({
      depositCents: 2000,
      depositPaid: true,
      refundDepositOnCancel: false,
      depositLabel: "€20.00",
    });

    expect(sentence).toContain("not refunded");
    /* No hedging and no euphemism: they are about to lose twenty euros and the
       sentence says so with the number in it. */
    expect(sentence).toContain("€20.00");
  });

  it("says nothing at all when there is no money in play", () => {
    expect(
      describeCancellationOutcome({
        depositCents: 0,
        depositPaid: false,
        refundDepositOnCancel: true,
        depositLabel: "€0.00",
      }),
    ).toBeNull();

    /* A deposit that was never taken — an owner-entered booking paid at the
       counter — has nothing to refund and nothing to warn about. */
    expect(
      describeCancellationOutcome({
        depositCents: 2000,
        depositPaid: false,
        refundDepositOnCancel: false,
        depositLabel: "€20.00",
      }),
    ).toBeNull();
  });
});

describe("when a manage link stops working", () => {
  it("counts from the END of the appointment, not from the booking", () => {
    const endsAt = new Date("2026-09-05T11:30:00Z");
    const expires = manageTokenExpiresAt(endsAt);

    expect(expires.getTime() - endsAt.getTime()).toBe(
      MANAGE_TOKEN_TTL_DAYS * 86_400_000,
    );

    /* A booking made eleven months ahead and one made yesterday get the same
       window on the part that matters. */
    expect(expires.toISOString()).toBe("2026-11-04T11:30:00.000Z");
  });
});
