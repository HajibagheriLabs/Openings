/**
 * The rules of booking here, in one place — and in words.
 *
 * TWO AUDIENCES, ONE SOURCE. The sentences below are what the customer reads
 * on the form; the numbers they are built from are what the server enforces at
 * submit. Keeping them in the same module is the point: a business that
 * shortens its cancellation window changes one column and the page, the
 * consent checkbox and the refusal message all move together. A policy that is
 * described in one file and enforced in another is a policy that will
 * eventually describe something the product does not do.
 *
 * NOTHING HERE IS A CHECK. These are strings and constants, shared by the
 * client and the server. The checks live in `src/server/booking/policy.ts`,
 * which is server-only, because a rule the browser could skip is not a rule.
 */

/**
 * The cancellation window, said plainly and never behind a link.
 *
 * "Free cancellation up to 24 hours before" is a promise somebody can act on.
 * "Cancellations are subject to our policy" is a sentence that exists to be
 * scrolled past, and putting it behind a link guarantees it is. The customer
 * ticks a box next to THIS text.
 */
export function describeCancellationWindow(hours: number): string {
  if (hours <= 0) {
    return "You can cancel any time before your appointment.";
  }

  if (hours === 1) {
    return "You can cancel up to an hour before your appointment. After that the slot is yours.";
  }

  if (hours % 24 === 0) {
    const days = hours / 24;

    return `You can cancel up to ${
      days === 1 ? "a day" : `${days} days`
    } before your appointment. After that the slot is yours.`;
  }

  return `You can cancel up to ${hours} hours before your appointment. After that the slot is yours.`;
}

/** What happens to a deposit on a late cancellation, in the same voice. */
export function describeDepositPolicy(depositCents: number): string | null {
  if (depositCents <= 0) {
    return null;
  }

  return "Cancel inside that window and the deposit is not refunded.";
}

/** Whether the customer may move the appointment themselves, said plainly. */
export function describeReschedule(allowReschedule: boolean): string {
  return allowReschedule
    ? "You can move it to another time from the link in your confirmation email."
    : "To move it to another time, get in touch — it cannot be changed from the link.";
}

/**
 * The whole policy as the sentences the consent box covers.
 *
 * Returned as a list rather than one paragraph so the form can set them as
 * separate lines. A wall of policy prose is read by nobody; three short
 * sentences with air around them are read by most people.
 */
export function cancellationPolicyLines(input: {
  cancellationWindowHours: number;
  allowReschedule: boolean;
  depositCents: number;
}): string[] {
  return [
    describeCancellationWindow(input.cancellationWindowHours),
    describeDepositPolicy(input.depositCents),
    describeReschedule(input.allowReschedule),
  ].filter((line): line is string => line !== null);
}

/* ---------------------------------------------------------------------------
   Refusals
--------------------------------------------------------------------------- */

/**
 * A booking the product declines, said in a way somebody can act on.
 *
 * Shared rather than server-only because the client renders it, and because
 * the SHAPE is part of the contract: a refusal always carries a code the
 * client can route on and a message written for a person. There is no path
 * that surfaces an exception string to a customer.
 */
export interface PolicyRefusal {
  code:
    | "hold-expired"
    | "too-soon"
    | "too-far"
    | "unavailable"
    | "duplicate"
    | "rate-limited";
  message: string;
  /** Set for `duplicate`: the appointment they already have. */
  existing?: { startsAt: string; endsAt: string; serviceName: string };
}

/* ---------------------------------------------------------------------------
   Rate limits
--------------------------------------------------------------------------- */

/**
 * WHY THERE IS A LIMIT AT ALL.
 *
 * A hold is anonymous and free, and it takes a real slot out of the calendar
 * for eight minutes. One browser can only ever hold ONE slot — the cookie
 * carries a single appointment and `moveHold` releases the previous one inside
 * the same transaction — so the ordinary visitor cannot lock anything. Somebody
 * with a stack of private windows can, and the only thing they have to give us
 * that is stable across those windows is the email they eventually type.
 *
 * So the limit lands here, at the details step, where an email first appears.
 * It is not perfect: a fresh address each time walks past it. It is not
 * supposed to be perfect — it is supposed to stop the ordinary version of this,
 * which is one person quietly holding six slots "to decide later" while the
 * day looks full to everybody else.
 */

/**
 * Upcoming appointments one email may have at one business, held or confirmed.
 *
 * Three is generous for a real customer — a haircut, a colour and something
 * for a partner — and useless for holding a day open.
 */
export const MAX_UPCOMING_PER_EMAIL = 3;

/** Bookings one email may start in a rolling window, whatever became of them. */
export const MAX_BOOKINGS_PER_WINDOW = 6;

/** How long that window is, in minutes. */
export const BOOKING_WINDOW_MINUTES = 60;

/** What the customer is told when they hit either limit. Never "rate limit". */
export function rateLimitMessage(reason: "upcoming" | "recent"): string {
  return reason === "upcoming"
    ? `You already have ${MAX_UPCOMING_PER_EMAIL} appointments coming up with us. Cancel one from your confirmation email, or get in touch and we will sort it out.`
    : "That is a lot of bookings in a short time. Give it a few minutes, or get in touch and we will book you in directly.";
}
