import "server-only";

import type { StartCheckoutResult } from "@/lib/booking/checkout";
import {
  loadCheckoutTarget,
  startCheckout,
} from "@/server/payments/checkout-session";

/**
 * Take a held, claimed appointment to Stripe — or say, in words a customer can
 * act on, why that did not happen.
 *
 * NOT A SERVER ACTION, deliberately. It takes an appointment id, and every
 * export of a `"use server"` file is a public HTTP endpoint: exporting this one
 * would let anybody with an id open a Checkout Session against somebody else's
 * booking. The two callers — the details submit and the retry button — each
 * resolve the appointment from the browser's own hold cookie first, and only
 * then call in here.
 */
export async function handOffToStripe(
  appointmentId: string,
  now: Date,
): Promise<StartCheckoutResult> {
  const target = await loadCheckoutTarget(appointmentId);

  if (!target) {
    /* The load joins the customer, so a miss means the details were never
       saved or the hold is gone. Either way the way forward is the picker. */
    return {
      ok: false,
      reason: "policy",
      refusal: {
        code: "hold-expired",
        message:
          "Your hold ran out before payment started. Nothing was booked and nothing was charged — pick a time again.",
      },
    };
  }

  try {
    const handoff = await startCheckout(target, now);

    if (handoff.ok) {
      return handoff.url === null
        ? { ok: true, url: null, alreadyPaid: true }
        : { ok: true, url: handoff.url };
    }

    if (handoff.reason === "no-deposit") {
      /* Nothing owed means the details step should already have confirmed it.
         Reaching here is our bug, not the customer's problem. */
      console.error(
        `[checkout] appointment ${appointmentId} reached payment with no deposit owed`,
      );

      return { ok: false, reason: "error", message: BROKE_MESSAGE };
    }

    /**
     * STRIPE IS NOT CONFIGURED.
     *
     * A real state, not an impossible one: this project is meant to run on a
     * laptop with nothing but a database, and the mailer degrades the same way.
     * What it must not do is degrade SILENTLY into a free booking — a deposit
     * the business expected would go uncollected and nobody would be told. So
     * the slot stays held, the customer is given a way to sort it out with the
     * business directly, and the reason is in the server log for the owner.
     */
    console.warn(
      "[checkout] STRIPE_SECRET_KEY is not set — a deposit was due and could not be taken.",
    );

    return {
      ok: false,
      reason: "error",
      message:
        "Card payment is not switched on for this business yet. Your slot is still held — get in touch and they will take the deposit directly.",
    };
  } catch (error) {
    /* A Stripe outage, a rejected parameter, a network failure. The hold is
       untouched and the details are saved, so "try again" is honest advice —
       and the exception stays in the server log where it belongs. */
    console.error("[checkout] could not create a Checkout Session", error);

    return { ok: false, reason: "error", message: BROKE_MESSAGE };
  }
}

/** The generic failure. An exception message never reaches a customer. */
export const BROKE_MESSAGE =
  "We could not open the payment page just now. Your slot is still held — try again in a moment.";
