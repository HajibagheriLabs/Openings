/**
 * What the wizard holds while it is being filled in.
 *
 * Written out rather than inferred from the Zod schemas, because the two
 * describe different moments. The schemas describe a FINISHED answer —
 * `timezoneConfirmed` is `true`, not a boolean — while these describe a form
 * mid-typing, where every field can still be empty or wrong. Inferring the
 * first from the second would make an unticked checkbox a type error.
 */

/** Field name to message, e.g. `{ slug: "That address is taken." }`. */
export type FieldErrors = Record<string, string>;

export interface BusinessStepValue {
  name: string;
  slug: string;
  timezone: string;
  timezoneConfirmed: boolean;
  /**
   * Once the owner edits the address by hand, the business name stops
   * rewriting it. Typing a name, fixing the address, then fixing a typo in the
   * name should not silently undo the fix.
   */
  slugEdited: boolean;
}

export interface HoursStepDayValue {
  /** 0 = Sunday … 6 = Saturday, matching Postgres `extract(dow)`. */
  weekday: number;
  isOpen: boolean;
  /** "HH:MM", local wall-clock in the business's timezone. Never an instant. */
  startLocal: string;
  endLocal: string;
}

export type HoursStepValue = HoursStepDayValue[];

export interface ServiceStepValue {
  name: string;
  durationMin: number;
  currency: string;
  /** As typed: "45", "45.00", "45,50". Converted to cents on the server. */
  price: string;
  depositType: "none" | "flat" | "percent";
  /** Amount when flat, whole percent when percent, ignored when none. */
  deposit: string;
}

export const STEPS = ["business", "hours", "service"] as const;

export type StepName = (typeof STEPS)[number];
