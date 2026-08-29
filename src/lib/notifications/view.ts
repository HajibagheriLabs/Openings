import { formatInstant } from "@/components/time-text";

/**
 * The facts every booking email is given, resolved once on the server.
 *
 * ONE SHAPE, SEVEN TEMPLATES. Each template picks what it needs out of this
 * and none of them queries anything, formats a currency from a raw price, or
 * works out a duration. That is what makes them renderable in a test with a
 * literal object — and it is what stops the confirmation and the reminder
 * quietly disagreeing about which staff member is expected.
 *
 * PURE. No `server-only`, no configuration, no database. The links are strings
 * that were built elsewhere, because a template that knew how to build a URL
 * would be a template that could build the wrong one.
 */

/** The appointment's clock, said in one zone or two. */
export interface EmailTimes {
  /** ISO instants. The templates format these and do no arithmetic. */
  startsAt: string;
  endsAt: string;
  /** The BUSINESS's IANA zone. This is the authoritative one, always shown. */
  timeZone: string;
  /**
   * The customer's own zone — present only when it was captured AND shows a
   * different clock. Null covers both "we were never told" and "they are in
   * Paris and we are in Berlin", and the second is the important one: a
   * second line reading exactly the same time as the first is noise that
   * teaches people to skip the timezone line entirely.
   */
  visitorTimeZone: string | null;
}

export interface EmailBooking {
  businessName: string;
  serviceName: string;
  staffName: string;
  durationMin: number;
  times: EmailTimes;
  /** The street address, or null when the business has none on file. */
  location: string | null;
  contactEmail: string;
  contactPhone: string | null;

  currency: string;
  priceCents: number;
  depositCents: number;
  /** Whether the deposit has actually been taken, or is still due on the day. */
  depositPaid: boolean;
  balanceCents: number;

  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  customerNote: string | null;

  /** The cancellation policy in plain sentences, as the customer agreed to it. */
  policyLines: string[];

  /** Absolute URLs, built by the caller. */
  manageUrl: string;
  icsUrl: string;
  googleUrl: string;
}

/**
 * Do two zones show the same wall clock at this instant?
 *
 * Asked by FORMATTING, not by arithmetic: Paris and Berlin are different
 * identifiers and the same clock, and so are a great many zones a browser
 * might name by country. Comparing the rendered strings answers the question
 * the reader actually has — "will this line tell me anything new?" — which
 * subtracting offsets does not.
 */
export function zonesAgree(
  instant: string,
  a: string,
  b: string,
): boolean {
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: "short",
    timeStyle: "short",
  };

  return (
    formatInstant(instant, a, options) === formatInstant(instant, b, options)
  );
}

/**
 * The customer's zone, or null when printing it would say nothing.
 *
 * An unrecognised identifier is treated as absent rather than thrown on: this
 * decides whether one courtesy line appears, and a stored value the runtime
 * has never heard of must not be able to stop a confirmation going out.
 */
export function visitorZoneFor(
  instant: string,
  businessTimeZone: string,
  customerTimeZone: string | null,
): string | null {
  if (!customerTimeZone || customerTimeZone === businessTimeZone) {
    return null;
  }

  try {
    return zonesAgree(instant, businessTimeZone, customerTimeZone)
      ? null
      : customerTimeZone;
  } catch {
    return null;
  }
}
