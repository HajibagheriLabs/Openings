/**
 * What makes a service bookable.
 *
 * ONE DEFINITION, TWO CALLERS. The public booking page asks this before it
 * offers a service, and the admin list asks the same function before it draws
 * a flag. If they were two pieces of logic they would drift, and the failure
 * mode of that drift is the worst one in this product: a service the owner can
 * see and edit and believes is live, which quietly never appears to a single
 * customer.
 *
 * Pure — no database, no `server-only`. The admin's client components import
 * the copy below to explain a flag, and the server imports the predicate.
 */

export type UnbookableReason = "inactive" | "no-active-staff" | "off-grid";

export interface ServiceBookability {
  bookable: boolean;
  /** Empty when bookable. Ordered most-blocking first. */
  reasons: UnbookableReason[];
}

/** The shape this needs off a service row — not the whole row. */
export interface BookabilityInput {
  isActive: boolean;
  durationMin: number;
  /**
   * How many ACTIVE staff are assigned to it. A service linked only to
   * deactivated people is as unbookable as one linked to nobody: the
   * availability algorithm expands rules per staff member, and a deactivated
   * member contributes no rules.
   */
  activeStaffCount: number;
}

export function serviceBookability(
  service: BookabilityInput,
  slotGranularityMin: number,
): ServiceBookability {
  const reasons: UnbookableReason[] = [];

  if (!service.isActive) {
    reasons.push("inactive");
  }

  if (service.activeStaffCount === 0) {
    reasons.push("no-active-staff");
  }

  /**
   * A duration that is not a whole number of slots is not strictly
   * unbookable — the window still slides — but it produces start times that
   * cannot chain: a 50-minute service on a 15-minute grid leaves a 10-minute
   * orphan after every booking, forever. The guard exists so the owner never
   * discovers that by looking at a month of ragged days.
   *
   * Defensive: granularity is validated on the business row, but a zero here
   * would be a division by zero rather than a flag.
   */
  if (
    slotGranularityMin > 0 &&
    (service.durationMin <= 0 || service.durationMin % slotGranularityMin !== 0)
  ) {
    reasons.push("off-grid");
  }

  return { bookable: reasons.length === 0, reasons };
}

/**
 * What the owner is told, and what to do about it.
 *
 * Errors say what happened and what to do. Never "invalid", never an apology.
 */
export const UNBOOKABLE_COPY: Record<
  UnbookableReason,
  { summary: string; fix: string }
> = {
  inactive: {
    summary: "Switched off",
    fix: "Turn it back on to offer it again. Existing appointments are untouched either way.",
  },
  "no-active-staff": {
    summary: "Nobody can perform it",
    fix: "Assign at least one active staff member. Until then it does not appear on your booking page.",
  },
  "off-grid": {
    summary: "Length does not fit the booking grid",
    fix: "Change the duration to a whole number of booking intervals so appointments can sit back to back.",
  },
};

/** A one-line summary for a list row, e.g. "Not bookable — nobody can perform it". */
export function unbookableSummary(reasons: UnbookableReason[]): string | null {
  if (reasons.length === 0) {
    return null;
  }

  return reasons.map((reason) => UNBOOKABLE_COPY[reason].summary).join(" · ");
}
