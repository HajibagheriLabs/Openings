import { describe, expect, it } from "vitest";

import {
  buildCheckoutSessionParams,
  checkoutExpiresAt,
  chooseCaptureMethod,
  CHECKOUT_METADATA,
  describeDepositLineItem,
  isOwnObject,
  MANUAL_CAPTURE_HORIZON_DAYS,
  OWNER_TAG,
  STRIPE_MIN_SESSION_MINUTES,
  type CheckoutAppointment,
} from "@/lib/payments/checkout";

/**
 * The Checkout Session, checked without touching the network.
 *
 * Everything with a rule in it — the amount, the capture method, the expiry,
 * the ownership tag — is built by a pure function precisely so it can be
 * asserted here. The only thing left for the server module is the API call.
 */

const NOW = new Date("2026-08-27T09:00:00Z");

const appointment: CheckoutAppointment = {
  id: "5f2b8f1c-6a3e-4c7d-9a11-2b3c4d5e6f70",
  businessId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  startsAt: "2026-08-28T12:00:00Z",
  endsAt: "2026-08-28T13:30:00Z",
  serviceName: "Cut and colour",
  durationMin: 90,
  staffName: "Rosa",
  currency: "EUR",
  priceCents: 9000,
  depositCents: 2000,
  customerEmail: "sam@example.com",
  timeZone: "Europe/Berlin",
  businessName: "Rosa's Hair Studio",
};

const params = (over: Partial<CheckoutAppointment> = {}, now = NOW) =>
  buildCheckoutSessionParams({
    appointment: { ...appointment, ...over },
    successUrl: "https://example.test/book/rosas?step=confirming",
    cancelUrl: "https://example.test/api/book/checkout/cancel?slug=rosas",
    now,
    manualCaptureEnabled: false,
  });

describe("buildCheckoutSessionParams", () => {
  it("charges the deposit off the appointment, in the business's currency", () => {
    const session = params();
    const item = session.line_items?.[0];

    expect(item?.quantity).toBe(1);
    expect(item?.price_data?.unit_amount).toBe(2000);
    /* Stripe wants lowercase; the business row stores "EUR". */
    expect(item?.price_data?.currency).toBe("eur");
  });

  it("names the appointment in BOTH client_reference_id and metadata", () => {
    const session = params();

    expect(session.client_reference_id).toBe(appointment.id);
    expect(session.metadata?.[CHECKOUT_METADATA.appointmentId]).toBe(
      appointment.id,
    );
  });

  it("tags every object as ours, so a shared Stripe account cannot confuse the webhook", () => {
    /* A test-mode account is per developer, not per project, and `stripe
       listen` forwards every event on it. The tag is how the webhook tells
       this application's payments from another application's. */
    const session = params();

    expect(session.metadata?.[CHECKOUT_METADATA.app]).toBe(OWNER_TAG);
    expect(
      session.payment_intent_data?.metadata?.[CHECKOUT_METADATA.app],
    ).toBe(OWNER_TAG);
    /* On the PaymentIntent too, because `charge.refunded` arrives carrying a
       charge and never the session. */
    expect(
      session.payment_intent_data?.metadata?.[CHECKOUT_METADATA.appointmentId],
    ).toBe(appointment.id);
  });

  it("pre-fills the email the customer typed on the details step", () => {
    expect(params().customer_email).toBe("sam@example.com");
  });

  it("captures immediately by default", () => {
    /* The default is the whole point: Stripe cancels an uncaptured
       PaymentIntent after roughly seven days, so an authorization on anything
       booked further out dies before the appointment. */
    expect(params().payment_intent_data?.capture_method).toBe("automatic");
  });

  it("expires at Stripe's floor, not at the hold's deadline", () => {
    /* An eight-minute hold cannot be expressed as `expires_at` — Stripe's
       minimum is thirty minutes. The cancel route and the hold's own deadline
       are what actually end an abandoned checkout; this is the backstop. */
    const session = params();

    expect(session.expires_at).toBe(
      Math.floor(NOW.getTime() / 1000) + STRIPE_MIN_SESSION_MINUTES * 60,
    );
    expect(checkoutExpiresAt(NOW)).toBe(session.expires_at);
  });

  it("is a one-off payment, and says Book on the button", () => {
    const session = params();

    expect(session.mode).toBe("payment");
    expect(session.submit_type).toBe("book");
  });

  it("refuses to build a session for a booking with nothing to pay", () => {
    /* Checkout rejects a zero-amount payment session anyway, and a free
       consultation is confirmed at the details step. Reaching here is a bug. */
    expect(() => params({ depositCents: 0 })).toThrow(/no deposit/i);
  });
});

describe("chooseCaptureMethod", () => {
  const startsAt = (days: number) =>
    new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);

  it("is automatic when the business has not opted in, however close the appointment", () => {
    expect(
      chooseCaptureMethod({
        startsAt: startsAt(1),
        now: NOW,
        manualCaptureEnabled: false,
      }),
    ).toBe("automatic");
  });

  it("allows manual capture only inside the window an authorization survives", () => {
    expect(
      chooseCaptureMethod({
        startsAt: startsAt(MANUAL_CAPTURE_HORIZON_DAYS - 1),
        now: NOW,
        manualCaptureEnabled: true,
      }),
    ).toBe("manual");
  });

  it("falls back to charging immediately beyond that window", () => {
    /* THE FAILURE THIS PREVENTS: an uncaptured PaymentIntent for an
       appointment three weeks out is cancelled by Stripe long before the day.
       No money, no notice, an empty chair. */
    expect(
      chooseCaptureMethod({
        startsAt: startsAt(MANUAL_CAPTURE_HORIZON_DAYS + 1),
        now: NOW,
        manualCaptureEnabled: true,
      }),
    ).toBe("automatic");
  });

  it("reaches the session it is asked for", () => {
    const session = buildCheckoutSessionParams({
      appointment,
      successUrl: "https://example.test/s",
      cancelUrl: "https://example.test/c",
      now: NOW,
      manualCaptureEnabled: true,
    });

    /* The fixture starts a little over a day out, so opting in gets manual. */
    expect(session.payment_intent_data?.capture_method).toBe("manual");
  });
});

describe("describeDepositLineItem", () => {
  it("repeats the booking back, in the business's timezone", () => {
    const { name, description } = describeDepositLineItem(appointment);

    expect(name).toBe("Deposit — Cut and colour");
    /* 12:00 UTC is 14:00 in Berlin in August. The customer reads a local time
       or they do not recognise their own booking. */
    expect(description).toContain("14:00");
    expect(description).toContain("Friday 28 August");
    expect(description).toContain("Rosa");
    expect(description).toContain("Rosa's Hair Studio");
    expect(description).toContain("€70.00");
  });

  it("does not call the whole bill a deposit", () => {
    const { name, description } = describeDepositLineItem({
      ...appointment,
      depositCents: appointment.priceCents,
    });

    expect(name).toBe("Cut and colour");
    expect(description).toContain("Nothing further to pay");
  });
});

describe("isOwnObject", () => {
  it("recognises this application's objects and nothing else", () => {
    expect(isOwnObject({ [CHECKOUT_METADATA.app]: OWNER_TAG })).toBe(true);
    expect(isOwnObject({ [CHECKOUT_METADATA.app]: "meridian" })).toBe(false);
    expect(isOwnObject({})).toBe(false);
    expect(isOwnObject(null)).toBe(false);
  });
});
