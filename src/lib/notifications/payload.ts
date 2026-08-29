/**
 * The extra facts a queued message needs, beyond the appointment it points at.
 *
 * Most notifications need nothing here: a confirmation and a reminder are
 * fully described by the appointment row they hang off, and duplicating any of
 * it into the outbox would let the row and the booking disagree after a
 * reschedule. This type exists for the two kinds that genuinely carry
 * something the appointment does not.
 *
 * IT IS NEVER A RENDERED MESSAGE. Templates live in code, so a wording fix
 * applies to every row still waiting in the queue; a pre-rendered body would
 * freeze yesterday's mistake into the outbox. And it is never a secret — the
 * manage-link token is minted when the email is composed, and only its hash is
 * ever stored.
 */

/** Times offered to somebody whose slot went. ISO instants, server-computed. */
export interface OfferedTime {
  startsAt: string;
  endsAt: string;
}

/**
 * The apology, for a deposit taken on a slot that had already gone.
 *
 * Carries the refund because the customer's first question is about their
 * money, and the alternatives because their second is about their appointment.
 */
export interface SlotLostPayload {
  kind: "slot_lost";
  /** What went back to the card, in integer cents. */
  refundedCents: number;
  /** ISO 4217, so the amount can be formatted without another query. */
  currency: string;
  /** The three nearest openings for the same service, soonest first. */
  alternatives: OfferedTime[];
  /** Where to pick one. A path, not an absolute URL — the origin is config. */
  rebookPath: string;
}

/**
 * An appointment moved.
 *
 * The ONE fact a reschedule email needs that the appointment no longer carries:
 * where it moved FROM. Once the row is updated, `starts_at` is the new time and
 * the old one exists nowhere — so the message that has to print both has to
 * have been told, at the moment the change was made, what it was replacing.
 *
 * `movedBy` is here rather than derived because "you moved this" and "we moved
 * this" are different first sentences, and the row records who CANCELLED, not
 * who rescheduled.
 */
export interface ReschedulePayload {
  kind: "reschedule";
  /** ISO instants, as the appointment read before the change. */
  previousStartsAt: string;
  previousEndsAt: string;
  movedBy: "customer" | "business";
}

/** Money went back to a customer. Addressed to the OWNER, not the customer. */
export interface RefundPayload {
  kind: "refund";
  refundedCents: number;
  currency: string;
  /** Whether the whole deposit went back, or only part of it. */
  full: boolean;
  /** Stripe's charge id, so the owner can find it in their dashboard. */
  chargeId: string;
}

export type NotificationPayload =
  | SlotLostPayload
  | ReschedulePayload
  | RefundPayload;
