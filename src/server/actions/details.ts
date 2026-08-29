"use server";

import { headers } from "next/headers";
import { z } from "zod";

import { db } from "@/db";
import type { SubmitDetailsResult } from "@/lib/booking/details";
import type { PolicyRefusal } from "@/lib/booking/policy";
import { dispatchDeliveries } from "@/lib/notifications/delivery";
import { claimHold } from "@/lib/scheduling/booking";
import { loadDayView } from "@/lib/scheduling/day-view";
import {
  bookingDetailsSchema,
  type BookingDetailsField,
} from "@/lib/validation/booking-details";
import { handOffToStripe } from "@/server/booking/checkout";
import { loadDetailsContext } from "@/server/booking/details";
import {
  CONFIRMED_COOKIE_SECONDS,
  writeHoldCookie,
} from "@/server/booking/hold-cookie";
import { localDateOf } from "@/server/booking/picker";
import {
  clientAddressOf,
  consumeRateLimit,
  DETAILS_EMAIL_RULE,
  DETAILS_IP_RULE,
  MIN_SECONDS_ON_FORM,
  rateLimitKey,
} from "@/server/booking/rate-limit";
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

/**
 * A zone the runtime actually recognises, or nothing.
 *
 * The browser sends `Intl.DateTimeFormat().resolvedOptions().timeZone`, which
 * is normally a clean IANA identifier — but it arrives over a Server Action,
 * which is a public HTTP endpoint, so it is checked by ASKING THE PLATFORM
 * rather than by a pattern. Constructing a formatter is the only test that
 * agrees with what the formatter will later do with the value.
 *
 * An unrecognised zone is dropped rather than refused. It affects one
 * courtesy line in one email; throwing away a booking over it would be
 * absurd.
 */
const timeZoneSchema = z
  .string()
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  })
  .nullish()
  .catch(null);

const submitSchema = bookingDetailsSchema.extend({
  slug: z.string().min(1).max(64),
  /** The customer's own zone, for the second time line in their confirmation. */
  timeZone: timeZoneSchema,
});

/** The generic failure. An exception message never reaches a customer. */
const brokeMessage =
  "We could not finish that just now. Your slot is still held — try again in a moment.";

/** A refusal, in the shape the client routes on. */
function refuse(refusal: PolicyRefusal): SubmitDetailsResult {
  return { ok: false, reason: "policy", refusal };
}

/**
 * What an over-eager caller is told. See the note on the same message in
 * src/server/actions/booking.ts — it names the network, not the person.
 */
const busyRefusal: PolicyRefusal = {
  code: "rate-limited",
  message:
    "A lot of booking requests have come from your network just now. Wait a " +
    "minute and try again — your slot is still held.",
};

/**
 * What a bot is told, which is deliberately the SAME thing.
 *
 * A honeypot that says "you filled in the hidden field" is a honeypot that
 * gets fixed. A submit that fails the honeypot or arrives impossibly fast is
 * refused with the ordinary busy message, so an automated caller learns
 * nothing about which check caught it. A real person can only reach this by
 * an autofill extension writing into a hidden input, and the retry that
 * follows will work.
 */
const REJECTED_AS_AUTOMATED = busyRefusal;

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

  /**
   * CHECK 2a — HOW LONG THE FORM WAS OPEN.
   *
   * Measured from `hold.createdAt`, which Postgres stamped when the customer
   * chose the time, not from anything the browser sent. See the note on
   * MIN_SECONDS_ON_FORM for why a hidden "rendered at" field was rejected: it
   * is a number the caller controls, and a check over a number the caller
   * controls is not a check.
   */
  if (now.getTime() - hold.createdAt.getTime() < MIN_SECONDS_ON_FORM * 1000) {
    return refuse(REJECTED_AS_AUTOMATED);
  }

  /**
   * CHECK 2b — HOW FAST THIS ADDRESS IS SUBMITTING.
   *
   * Before the form is parsed, so a flood of malformed submissions costs a
   * counter rather than a validation pass. The email bucket cannot be counted
   * yet — the address has not been parsed — so it is counted below, as soon as
   * there is a valid one to count.
   */
  const address = clientAddressOf({ headers: await headers() });

  const byAddress = await consumeRateLimit(
    db,
    rateLimitKey("details:ip", address),
    DETAILS_IP_RULE,
  );

  if (!byAddress.allowed) {
    return refuse(busyRefusal);
  }

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

  /**
   * CHECK 3a — THE HONEYPOT.
   *
   * HERE, AND NOT IN THE SCHEMA, and the difference is the whole trap. A
   * schema that refused a filled honeypot would return an ordinary validation
   * failure naming the field, which tells whatever filled it exactly what
   * caught it. This returns the same refusal a rate-limited human gets, so an
   * automated caller learns nothing about which check it tripped.
   *
   * It also cannot be rendered: there is no visible field to hang a message
   * on. See the note on the field in @/lib/validation/booking-details.
   */
  if (details.company !== "") {
    return refuse(REJECTED_AS_AUTOMATED);
  }

  /**
   * CHECK 3b — HOW MANY SUBMISSIONS THIS EMAIL IS RECEIVING.
   *
   * The address is only knowable once the form has parsed, which is why it is
   * counted here and not beside the IP bucket. It is the bucket that bounds the
   * one attack an IP limit cannot touch: many sources, one victim's inbox.
   */
  const byEmail = await consumeRateLimit(
    db,
    rateLimitKey("details:email", details.email),
    DETAILS_EMAIL_RULE,
  );

  if (!byEmail.allowed) {
    return refuse(busyRefusal);
  }

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
      /* Never the business's zone as a stand-in. An absent answer means the
         email prints one time instead of two, which is correct; guessing would
         print a second time that is a lie. */
      timeZone: details.timeZone ?? null,
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

    /**
     * AFTER THE TRANSACTION. The booking is committed; this only decides how
     * quickly its queued messages leave.
     *
     * With a delivery service configured the confirmation is published to it
     * and arrives seconds later. Without one, it is sent INLINE right here —
     * which is what makes a fresh clone of this repository produce a real
     * confirmation email instead of a row waiting for tomorrow's cron.
     *
     * Awaited rather than fired and forgotten, because a serverless function
     * can be frozen the moment its response is returned and an un-awaited
     * promise would simply stop. It never throws; the worst case is a message
     * left pending for the daily catch-up.
     */
    const dispatched = await dispatchDeliveries(db, claimed.appointment.id);

    console.info(
      `[booking] ${claimed.appointment.id} confirmed with no deposit ` +
        `(${dispatched.scheduler}: ${dispatched.scheduled} scheduled, ` +
        `${dispatched.sentNow} sent, ${dispatched.deferred} deferred)`,
    );

    return { ok: true, outcome: "confirmed" };
  }

  /**
   * A DEPOSIT IS OWED, SO STRIPE IS THE NEXT STEP — started here, in the same
   * round trip, so the customer gets one click instead of two.
   *
   * The appointment stays `held`: the slot is still reserved, the countdown is
   * still running against the same row, and nothing about this is a
   * confirmation. Confirmation happens in the verified webhook and nowhere
   * else. If the session cannot be created, the details are still saved and
   * the slot is still held — the form says what happened and offers to try
   * again rather than throwing the booking away.
   */
  const checkout = await handOffToStripe(hold.id, now);

  return {
    ok: true,
    outcome: "payment-required",
    depositCents: hold.depositCents,
    checkout,
  };
}
