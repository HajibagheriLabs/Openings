import "server-only";

import type { BookingSummary } from "@/lib/booking/details";
import { cancellationPolicyLines } from "@/lib/booking/policy";

/**
 * The summary panel's facts, worked out once.
 *
 * ONE FUNCTION, THREE READERS: the details form's panel, the confirmation
 * screen, and — when payments land — the Stripe session. If the deposit were
 * computed separately in any of those, the number on the page and the number
 * charged could differ by a cent on a percentage, which is the kind of bug that
 * is noticed by exactly one customer and believed by nobody.
 *
 * THE MONEY COMES OFF THE APPOINTMENT, NOT OFF THE SERVICE. `price_cents` and
 * `deposit_cents` were snapshotted when the hold was written, precisely so an
 * owner editing their prices at four o'clock does not silently change what a
 * customer who started booking at ten to four is about to be charged.
 */
export function buildBookingSummary(input: {
  business: {
    timezone: string;
    currency: string;
    cancellationWindowHours: number;
    allowReschedule: boolean;
  };
  serviceName: string;
  durationMin: number;
  /** Resolved when the hold was taken — never "anyone available" by this point. */
  staffName: string;
  startsAt: Date;
  endsAt: Date;
  /** Off the appointment row. */
  priceCents: number;
  depositCents: number;
}): BookingSummary {
  return {
    serviceName: input.serviceName,
    staffName: input.staffName,
    startsAt: input.startsAt.toISOString(),
    endsAt: input.endsAt.toISOString(),
    timeZone: input.business.timezone,
    durationMin: input.durationMin,
    currency: input.business.currency,
    priceCents: input.priceCents,
    depositCents: input.depositCents,
    /* Never negative: the deposit is capped at the price when it is computed,
       so a 100% deposit leaves nothing owed rather than a penny of credit. */
    balanceCents: Math.max(input.priceCents - input.depositCents, 0),
    policyLines: cancellationPolicyLines({
      cancellationWindowHours: input.business.cancellationWindowHours,
      allowReschedule: input.business.allowReschedule,
      depositCents: input.depositCents,
    }),
  };
}
