"use server";

import { z } from "zod";

import { db } from "@/db";
import type { SubmitDetailsResult } from "@/lib/booking/details";
import type { PolicyRefusal } from "@/lib/booking/policy";
import { claimHold } from "@/lib/scheduling/booking";
import { loadDayView } from "@/lib/scheduling/day-view";
import {
  bookingDetailsSchema,
  type BookingDetailsField,
} from "@/lib/validation/booking-details";
import { loadDetailsContext } from "@/server/booking/details";
import { writeHoldCookie } from "@/server/booking/hold-cookie";
import { localDateOf } from "@/server/booking/picker";
import {
  checkLeadTime,
  checkMaxAdvance,
  checkRateLimit,
  findOverlappingConfirmed,
} from "@/server/booking/policy";

/**
 * Finishing the booking.
 *
 * EVERY POLICY CHECK RUNS HERE, IN THIS ORDER, AGAINST THE DATABASE AS IT
 * STANDS NOW. The picker's copies of these rules explain why a slot was not
 * offered; the sentences on the form explain what the customer is agreeing to.
 * Neither decides anything. Between the hold being taken and this button being
 * pressed, several minutes pass — a lead time elapses, an owner switches a
 * service off, a stylist is deactivated, the same person books from their
 * phone — so the whole list is asked again rather than trusted.
 *
 * THE ORDER IS DELIBERATE. The hold is checked first because a dead hold makes
 * every other answer irrelevant and is the one thing the customer must be told
 * immediately. The form is parsed next, before any further queries, so a typo
 * costs nothing. Everything after that needs the email, which only exists once
 * the form has parsed.
 */

const submitSchema = bookingDetailsSchema.extend({
  slug: z.string().min(1).max(64),
});

/** The generic failure. An exception message never reaches a customer. */
const brokeMessage =
  "We could not finish that just now. Your slot is still held — try again in a moment.";

/** A refusal, in the shape the client routes on. */
function refuse(refusal: PolicyRefusal): SubmitDetailsResult {
  return { ok: false, reason: "policy", refusal };
}

export async function submitDetails(
  input: z.input<typeof submitSchema>,
): Promise<SubmitDetailsResult> {
  /* One clock for the whole submit, so the lead-time check, the horizon check
     and the availability re-run cannot disagree because a second passed. */
  const now = new Date();

  const slug = typeof input?.slug === "string" ? input.slug : null;

  if (!slug) {
    return { ok: false, reason: "error", message: brokeMessage };
  }

  /* CHECKS 1 AND 2 — the hold is live and theirs; the service and the staff
     member are still active. Both live in `loadDetailsContext`, because the
     page that renders this form has to answer exactly the same questions. */
  const loaded = await loadDetailsContext(slug, now);

  if (!loaded.ok) {
    return refuse(loaded.refusal);
  }

  const { picker, hold, cookie } = loaded.context;

  /* CHECK 3 — the form itself. Parsed with the same schema the browser used,
     because everything the browser did is a suggestion. */
  const parsed = submitSchema.safeParse(input);

  if (!parsed.success) {
    const fieldErrors: Partial<Record<BookingDetailsField, string>> = {};

    for (const issue of parsed.error.issues) {
      const field = issue.path[0];

      if (typeof field === "string" && field !== "slug" && !(field in fieldErrors)) {
        fieldErrors[field as BookingDetailsField] = issue.message;
      }
    }

    return { ok: false, reason: "invalid", fieldErrors };
  }

  const details = parsed.data;

  /* CHECK 4 — minimum lead time, measured now rather than when the day was
     drawn. Time passes while a form is filled in. */
  const tooSoon = checkLeadTime(
    hold.startsAt,
    picker.policy.minLeadTimeMin,
    now,
  );

  if (tooSoon) {
    return refuse(tooSoon);
  }

  /* CHECK 5 — the booking horizon, as a local day boundary in the business's
     zone, exactly as the availability engine reads it. */
  const tooFar = checkMaxAdvance(
    hold.startsAt,
    picker.policy.maxAdvanceDays,
    picker.timeZone,
    now,
  );

  if (tooFar) {
    return refuse(tooFar);
  }

  /**
   * CHECK 6 — the catch-all: is this instant still one the day would offer?
   *
   * The four checks above name their reason, which is what makes their
   * messages useful. This one re-runs the WHOLE availability algorithm for the
   * day and asks whether the held start survives it — so opening hours that
   * changed, a closure the owner added ten minutes ago, or a rule that expired
   * at midnight are all caught even though none of them has a message of its
   * own. The customer's own hold is excluded, or it would block itself.
   */
  const day = await loadDayView({
    db,
    businessId: picker.businessId,
    serviceId: picker.service.id,
    staffId: hold.staffId,
    timeZone: picker.timeZone,
    date: localDateOf(hold.startsAt.toISOString(), picker.timeZone),
    now,
    excludeAppointmentId: hold.id,
  });

  if (!day || !day.starts.has(hold.startsAt.toISOString())) {
    return refuse({
      code: "unavailable",
      message:
        "That time is no longer being offered. Pick another and we will hold it for you.",
    });
  }

  /* CHECK 7 — one person, one appointment at a time. A second booking across
     the same hour is almost always a double submit or a forgotten booking, and
     never something to create quietly. */
  const duplicate = await findOverlappingConfirmed(db, {
    businessId: picker.businessId,
    email: details.email,
    startsAt: hold.startsAt,
    endsAt: hold.endsAt,
    excludeAppointmentId: hold.id,
  });

  if (duplicate) {
    return refuse(duplicate);
  }

  /* CHECK 8 — how much of the calendar this email may sit on at once. */
  const rateLimited = await checkRateLimit(db, {
    businessId: picker.businessId,
    email: details.email,
    now,
    excludeAppointmentId: hold.id,
  });

  if (rateLimited) {
    return refuse(rateLimited);
  }

  /**
   * NOTHING OWED MEANS NOTHING TO PAY FOR.
   *
   * The deposit comes off the appointment row, snapshotted when the hold was
   * written, so an owner changing their prices mid-form cannot change what
   * this customer is charged. Zero is not a special case to be handled
   * somewhere later — it is the whole rest of the flow, decided here.
   */
  const confirmNow = hold.depositCents <= 0;

  const claimed = await claimHold(db, {
    appointmentId: hold.id,
    manageToken: cookie.manageToken,
    businessId: picker.businessId,
    customer: {
      name: details.name,
      email: details.email,
      phone: details.phone === "" ? null : details.phone,
    },
    customerNote: details.note === "" ? null : details.note,
    policyAcceptedAt: now,
    confirmNow,
  });

  if (!claimed.ok) {
    /* The hold was swept between the checks and the write — a genuinely narrow
       window, and the honest answer is the same as any other dead hold. */
    return refuse({
      code: "hold-expired",
      message:
        "Your hold ran out just as you pressed the button. Nothing was booked and nothing was charged — pick a time again.",
    });
  }

  if (confirmNow) {
    /**
     * Keep the cookie, and keep it for longer.
     *
     * It stops being "the slot I am holding" and becomes "the appointment this
     * browser just made", which is what lets a refresh of the confirmation
     * screen still show the booking instead of a picker. The manage token in
     * it is the same one the confirmation email carries.
     */
    await writeHoldCookie(cookie, CONFIRMED_COOKIE_SECONDS);

    return { ok: true, outcome: "confirmed" };
  }

  return {
    ok: true,
    outcome: "payment-required",
    depositCents: hold.depositCents,
  };
}

/**
 * How long the confirmation stays readable in this browser.
 *
 * A day. Long enough to survive a refresh, a shared phone being handed back
 * and a walk home; short enough that a public library machine is not carrying
 * somebody's booking a week later. The confirmation email is the durable copy.
 */
const CONFIRMED_COOKIE_SECONDS = 24 * 60 * 60;
