import type { EmailBooking } from "../../src/lib/notifications/view";

/**
 * One appointment, used by every template's `PreviewProps` and by the render
 * tests.
 *
 * SHARED ON PURPOSE. A fixture that lives in the test file drifts from the one
 * the preview server shows, and then the templates are checked against a
 * booking nobody has ever looked at. This is the booking in both places.
 *
 * It is deliberately awkward: a customer in another timezone, a deposit that
 * is neither zero nor the whole price, a note, and an address. Every template
 * is exercised against the case that has something to get wrong rather than
 * against the tidy one.
 */
export const PREVIEW_BOOKING: EmailBooking = {
  businessName: "Rosa's Hair Studio",
  serviceName: "Cut and colour",
  staffName: "Rosa Meier",
  durationMin: 90,
  times: {
    startsAt: "2026-09-03T12:00:00.000Z",
    endsAt: "2026-09-03T13:30:00.000Z",
    timeZone: "Europe/Berlin",
    visitorTimeZone: "America/New_York",
  },
  location: "Oranienstraße 12, 10999 Berlin",
  contactEmail: "hello@rosas.example",
  contactPhone: "+49 30 1234 5678",

  currency: "EUR",
  priceCents: 9000,
  depositCents: 2000,
  depositPaid: true,
  balanceCents: 7000,

  customerName: "Sam Meyer",
  customerEmail: "sam@example.com",
  customerPhone: "+1 212 555 0147",
  customerNote: "Growing out a fringe — happy to go shorter on the sides.",

  policyLines: [
    "You can cancel up to a day before your appointment. After that the slot is yours.",
    "Cancel inside that window and the deposit is not refunded.",
    "You can move it to another time from the link in your confirmation email.",
  ],

  manageUrl: "https://openings.example/manage/ap-1?t=preview-token",
  icsUrl: "https://openings.example/ics/ap-1?t=preview-token",
  googleUrl:
    "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Cut+and+colour",
};
