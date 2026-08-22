/**
 * Which steps this booking actually has, and which one the visitor is on.
 *
 * THE FLOW IS NOT FIXED. A one-chair barber with one service has two steps —
 * pick a day, pick a time — and showing them a "choose your service" screen
 * with a single card, then a "choose your stylist" screen with a single name,
 * is three taps of ceremony for no information. A clinic with six services and
 * four practitioners has four. The steps are derived from the data, so the
 * progress line is telling the truth about the flow this particular visitor is
 * in rather than about the product's maximum.
 *
 * Pure, and shared by the server page and the client picker, so the number in
 * the progress line and the step actually being rendered cannot drift.
 */

export type BookingStepId =
  | "service"
  | "staff"
  | "date"
  | "time"
  | "details"
  | "pay";

export const BOOKING_STEP_LABEL: Record<BookingStepId, string> = {
  service: "Service",
  staff: "Who",
  date: "Day",
  time: "Time",
  details: "Your details",
  pay: "Deposit",
};

export interface BookingFlow {
  /** Only the steps that exist for this business, in order. */
  steps: BookingStepId[];
  current: BookingStepId;
  /** 1-based position of `current`, for the progress line. */
  step: number;
  total: number;
}

export interface BookingFlowInput {
  /** Bookable services. One means the service step does not exist. */
  serviceCount: number;
  /**
   * Qualified, active staff for the CHOSEN service.
   *
   * While no service is chosen this is the LARGEST count across the bookable
   * services — the flow's maximum length, which is the only honest estimate
   * available before the choice is made. It can shrink once a service is
   * picked (that service turns out to have one practitioner), never grow, so
   * the progress line may jump forward but never backward.
   */
  staffCount: number;
  /**
   * Whether this service asks for a deposit.
   *
   * A FREE CONSULTATION HAS NO PAYMENT STEP, and the progress line must not
   * pretend otherwise — telling somebody there are five steps and finishing at
   * four is a small lie that makes every other number on the page suspect. The
   * deposit decides whether the step exists at all, not whether it is skipped.
   */
  hasDeposit: boolean;
  chosen: {
    service: boolean;
    staff: boolean;
    date: boolean;
    /** A live hold. The answer to "which time" lives in a cookie, not the URL. */
    time: boolean;
  };
}

export function buildBookingFlow(input: BookingFlowInput): BookingFlow {
  const steps: BookingStepId[] = [];

  if (input.serviceCount > 1) {
    steps.push("service");
  }

  if (input.staffCount > 1) {
    steps.push("staff");
  }

  steps.push("date", "time", "details");

  if (input.hasDeposit) {
    steps.push("pay");
  }

  /**
   * The current step is the first one still waiting for an answer. A step that
   * does not exist has nothing to wait for, so a single-service business goes
   * straight to the day — and a shared link that already carries every answer
   * lands on the last step, which is the whole point of putting the state in
   * the URL.
   */
  const answered: Record<BookingStepId, boolean> = {
    service: input.chosen.service,
    staff: input.chosen.staff,
    date: input.chosen.date,
    time: input.chosen.time,
    details: false,
    pay: false,
  };

  const currentIndex = steps.findIndex((step) => !answered[step]);
  const index = currentIndex === -1 ? steps.length - 1 : currentIndex;

  return {
    steps,
    current: steps[index],
    step: index + 1,
    total: steps.length,
  };
}
