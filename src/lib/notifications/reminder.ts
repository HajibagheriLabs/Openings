/**
 * When a reminder goes out, and whether it goes out at all.
 *
 * PURE, and shared by the two places that need the answer: the booking
 * transaction, which writes the outbox row, and the reschedule path, which
 * rewrites it. One implementation, because a reminder queued against one rule
 * and re-queued against another arrives at the wrong hour and looks like a bug
 * in the product rather than in a constant.
 *
 * No `server-only` — this is arithmetic on two numbers and the tests want it
 * without a database.
 */

/** The default when a business has never touched the setting: the day before. */
export const DEFAULT_REMINDER_LEAD_MIN = 24 * 60;

/**
 * Bounds the setting can take, in minutes.
 *
 * Fifteen minutes at the low end, because below that a reminder competes with
 * the appointment itself. A week at the high end, because a reminder further
 * out than that is not a reminder, it is a second confirmation — and it would
 * routinely be scheduled before the customer has even finished booking.
 */
export const MIN_REMINDER_LEAD_MIN = 15;
export const MAX_REMINDER_LEAD_MIN = 7 * 24 * 60;

/**
 * The instant a reminder should be delivered, or NULL when there is not one.
 *
 * NULL IS THE IMPORTANT CASE, and it is not an error. Somebody booking a
 * haircut for three hours' time, at a business that reminds a day ahead, has
 * no reminder to receive: the moment for it passed before they booked. Writing
 * that row anyway would queue a message for a time already gone, which the
 * outbox would treat as overdue and deliver IMMEDIATELY — a "your appointment
 * is tomorrow" email arriving one minute after the confirmation, for an
 * appointment this afternoon.
 *
 * So the caller writes no reminder row at all, and the customer gets exactly
 * the one message the booking deserves.
 */
export function reminderInstantFor(input: {
  startsAt: Date;
  /** `businesses.reminder_lead_min`. */
  reminderLeadMin: number;
  /** One clock for the whole decision, passed in by the caller. */
  now: Date;
}): Date | null {
  const at = new Date(
    input.startsAt.getTime() - input.reminderLeadMin * 60_000,
  );

  return at.getTime() > input.now.getTime() ? at : null;
}

/** "a day before", "2 hours before", "45 minutes before" — for the admin. */
export function describeReminderLead(minutes: number): string {
  if (minutes === 7 * 24 * 60) {
    /* Nobody says "7 days". The settings list offers "a week before" and this
       is what confirms the change, so the two have to agree. */
    return "a week before";
  }

  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);

    return days === 1 ? "a day before" : `${days} days before`;
  }

  if (minutes % 60 === 0) {
    const hours = minutes / 60;

    return hours === 1 ? "an hour before" : `${hours} hours before`;
  }

  return `${minutes} minutes before`;
}
