import { z } from "zod";

/**
 * The details form's contract, parsed on BOTH sides.
 *
 * The browser parses it to put a message under the field the moment focus
 * leaves it. The server parses the same schema again, because a Server Action
 * is a public HTTP endpoint and everything the browser did is a suggestion. One
 * schema, so the two can never disagree about what a valid phone number is.
 *
 * No `server-only` here on purpose — this file is meant to be shared.
 */

/**
 * Deliberately loose.
 *
 * The strict thing to do is validate the email against a full RFC 5322 grammar
 * and refuse anything unusual. The correct thing is to accept anything that
 * could plausibly be an address and let the confirmation email be the test,
 * because the failure mode of a strict pattern is turning away a real customer
 * with a real address on a form they cannot argue with. Zod's check is enough
 * to catch a typo like a missing @; the rest is the mail server's job.
 */
const emailSchema = z
  .string()
  .trim()
  .min(1, "We need an email to send your confirmation to.")
  .max(254, "That address is too long.")
  .toLowerCase()
  .pipe(z.email("That does not look like an email address."));

/**
 * Digits, spaces, and the handful of characters people actually type.
 *
 * No country-code normalisation and no libphonenumber: the number is for a
 * human at the business to ring if something changes, not for a machine to
 * dial. Rejecting "07700 900 123 (after 6)" would be technically defensible
 * and unhelpful to everyone involved.
 */
const PHONE_PATTERN = /^[\d\s()+.\-/]{6,32}$/;

export const bookingDetailsSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Give us a name for the appointment.")
    .max(80, "That name is too long."),

  email: emailSchema,

  /**
   * OPTIONAL, AND THE FORM SAYS WHY.
   *
   * Making it required would cost bookings from people who do not want to give
   * a number. Leaving it unexplained means most people skip it and then are not
   * reachable on the one morning the business needs to reach them. So: optional
   * in the schema, and a concrete reason next to the field.
   */
  phone: z
    .string()
    .trim()
    .max(32, "That number is too long.")
    .refine((value) => value === "" || PHONE_PATTERN.test(value), {
      message: "Use digits, spaces and + ( ) - only.",
    })
    .optional()
    .default(""),

  note: z
    .string()
    .trim()
    .max(500, "Keep it under 500 characters — there is room to talk on the day.")
    .optional()
    .default(""),

  /**
   * The consent box, and the reason it is `literal(true)` rather than a
   * boolean: an unticked box is not a value to record, it is a form that has
   * not been completed. The policy it refers to is printed beside it in plain
   * words, on the page, never behind a link.
   */
  policyAccepted: z.literal(true, {
    message: "Tick the box to say you have read the cancellation policy.",
  }),
});

export type BookingDetailsInput = z.input<typeof bookingDetailsSchema>;
export type BookingDetails = z.output<typeof bookingDetailsSchema>;

/** The field names, for typed error maps on both sides. */
export type BookingDetailsField = keyof BookingDetails;

/** An empty form, so the client has one place that defines "blank". */
export const EMPTY_BOOKING_DETAILS: BookingDetailsInput = {
  name: "",
  email: "",
  phone: "",
  note: "",
  policyAccepted: false as unknown as true,
};
