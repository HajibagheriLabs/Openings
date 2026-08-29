/**
 * What a customer is allowed to do to their own appointment, and how long
 * their link keeps working.
 *
 * PURE, and shared by the page, the actions and the tests. No `server-only`:
 * the client renders the refusals and the confirm copy, so the sentences and
 * the decisions have to come from the same place. The decisions are still made
 * on the server — this module only makes sure both sides say the same thing.
 */

/* ===========================================================================
   Token lifetime
   =========================================================================== */

/**
 * How long a manage link keeps working after the appointment ENDS.
 *
 * ═══ WHY IT EXPIRES AT ALL ═══
 *
 * The token is a bearer credential sitting in an email inbox forever. Inboxes
 * get forwarded, screenshotted, synced to a shared family tablet and restored
 * onto a phone somebody sold. Nothing about the appointment needs the link to
 * work in 2029, so leaving it live is a credential kept alive for no reason.
 *
 * ═══ WHY IT IS COUNTED FROM THE APPOINTMENT, NOT FROM THE EMAIL ═══
 *
 * Because the link's job is the appointment. A booking made eleven months
 * ahead needs a link that works for eleven months; one made yesterday for
 * tomorrow does not. Counting from `ends_at` gives both the same generous
 * window on the only part that matters — the appointment itself and the weeks
 * after it, when somebody wants to see what they paid.
 *
 * ═══ WHY THERE IS NO COLUMN ═══
 *
 * It is derived: `ends_at + MANAGE_TOKEN_TTL_DAYS`. A stored expiry would be a
 * second copy of a fact the row already carries, and the two would drift the
 * first time an appointment moved — a rescheduled booking would keep the old
 * expiry, and nothing would notice until a link died early.
 *
 * Sixty days: long enough to cover a receipt request and a "when was I last
 * in?", short enough that a leaked inbox stops being a live door within a
 * quarter.
 */
export const MANAGE_TOKEN_TTL_DAYS = 60;

/** When a manage link for this appointment stops working. */
export function manageTokenExpiresAt(endsAt: Date): Date {
  return new Date(endsAt.getTime() + MANAGE_TOKEN_TTL_DAYS * 86_400_000);
}

/* ===========================================================================
   The cancellation window
   =========================================================================== */

/**
 * ═══ THE WORD "WINDOW" IS USED IN EXACTLY ONE DIRECTION HERE ═══
 *
 * `cancellation_window_hours` is the NOTICE the business asks for. A customer
 * is IN TIME while the appointment is further away than that, and LATE once it
 * is closer. Everything below says "in time" and "late" rather than "inside"
 * and "outside", because those two read in opposite directions depending on
 * whether you are thinking of the window as the permitted period or as the
 * closed one — and a policy that can be read backwards is a policy that will
 * be implemented backwards.
 */
export type CancellationTiming = "in-time" | "late" | "past";

export function cancellationTiming(input: {
  startsAt: Date;
  cancellationWindowHours: number;
  now: Date;
}): CancellationTiming {
  if (input.startsAt.getTime() <= input.now.getTime()) {
    return "past";
  }

  const noticeGiven = input.startsAt.getTime() - input.now.getTime();

  return noticeGiven >= input.cancellationWindowHours * 3_600_000
    ? "in-time"
    : "late";
}

/**
 * The notice period, as a person would say it.
 *
 * Shared with `describeCancellationWindow` in ./policy.ts, which builds the
 * sentence the consent box sits beside. This is the bare span, for the places
 * that need it inside a longer sentence.
 */
export function describeNotice(hours: number): string {
  if (hours <= 0) {
    return "any time";
  }

  if (hours === 1) {
    return "an hour";
  }

  if (hours % 24 === 0) {
    const days = hours / 24;

    return days === 1 ? "a day" : `${days} days`;
  }

  return `${hours} hours`;
}

/* ===========================================================================
   What the customer may do
   =========================================================================== */

export interface ManagePermissions {
  /** The appointment is live and still ahead of us. */
  isLive: boolean;
  canReschedule: boolean;
  canCancel: boolean;
  /** Why not, in words a person can act on. Null when they can. */
  rescheduleRefusal: string | null;
  cancelRefusal: string | null;
}

export interface ManagePolicyInput {
  status: "held" | "confirmed" | "completed" | "cancelled" | "no_show";
  startsAt: Date;
  cancellationWindowHours: number;
  allowReschedule: boolean;
  /** Shown in a refusal, because "ring them" needs a number. */
  contactPhone: string | null;
  now: Date;
}

/**
 * MOVING AND CANCELLING SHARE ONE WINDOW, deliberately.
 *
 * A business that asks for a day's notice to cancel is protecting the same
 * thing when somebody moves an appointment an hour beforehand: a slot that is
 * now too late to refill. Giving reschedule a softer rule would let the whole
 * cancellation policy be walked around by moving the appointment to next month
 * and cancelling it from there — which is not a hypothetical, it is the first
 * thing anybody tries.
 *
 * `allow_reschedule` is a separate, harder switch: a business that turns it
 * off does not want customers moving appointments at all, at any notice.
 */
export function managePermissions(
  input: ManagePolicyInput,
): ManagePermissions {
  const ring = input.contactPhone
    ? ` Give them a ring on ${input.contactPhone} and they will sort it out.`
    : " Get in touch with them and they will sort it out.";

  if (input.status === "cancelled") {
    return refuseBoth("This appointment is already cancelled.");
  }

  if (input.status === "no_show" || input.status === "completed") {
    return refuseBoth("This appointment has already happened.");
  }

  const timing = cancellationTiming({
    startsAt: input.startsAt,
    cancellationWindowHours: input.cancellationWindowHours,
    now: input.now,
  });

  if (timing === "past") {
    return refuseBoth("This appointment has already started.");
  }

  if (timing === "late") {
    /* Say the rule, not merely that it was broken — and give them the way out
       in the same breath. A refusal with no next step is a dead end, and the
       next step for a late change is a person. */
    const late =
      `There is less than ${describeNotice(input.cancellationWindowHours)} ` +
      `until your appointment, which is inside the notice this business asks ` +
      `for.${ring}`;

    return {
      isLive: true,
      canReschedule: false,
      canCancel: false,
      rescheduleRefusal: late,
      cancelRefusal: late,
    };
  }

  return {
    isLive: true,
    canReschedule: input.allowReschedule,
    canCancel: true,
    rescheduleRefusal: input.allowReschedule
      ? null
      : `This business does not take changes through this page.${ring}`,
    cancelRefusal: null,
  };
}

function refuseBoth(message: string): ManagePermissions {
  return {
    isLive: false,
    canReschedule: false,
    canCancel: false,
    rescheduleRefusal: message,
    cancelRefusal: message,
  };
}

/* ===========================================================================
   Money, said before the button is pressed
   =========================================================================== */

/**
 * What happens to the deposit if they cancel now — in one plain sentence.
 *
 * ═══ THIS IS SHOWN BEFORE THE CONFIRM BUTTON, NEVER AFTER ═══
 *
 * A customer who cancels and then discovers their deposit is gone has been
 * ambushed by software, and they are right to be angry about it. The sentence
 * is computed from the same two facts the action uses, so the screen cannot
 * promise a refund the server will not make.
 *
 * Returns null when there is no money in play at all — an absent sentence,
 * rather than one saying "£0.00 will be refunded", which invites the reader to
 * work out that nothing is happening.
 */
export function describeCancellationOutcome(input: {
  depositCents: number;
  depositPaid: boolean;
  refundDepositOnCancel: boolean;
  /** Already-formatted, because money formatting lives in one module. */
  depositLabel: string;
}): string | null {
  if (input.depositCents <= 0 || !input.depositPaid) {
    return null;
  }

  return input.refundDepositOnCancel
    ? `Your ${input.depositLabel} deposit goes back to the card you paid with. Banks usually take a few working days to show it.`
    : `Your ${input.depositLabel} deposit is not refunded — it is what held the slot. Cancelling here does not put it back.`;
}
