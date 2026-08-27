import { NextResponse } from "next/server";

import { db } from "@/db";
import { bookingUrl } from "@/lib/booking/url";
import { releaseHoldByToken } from "@/lib/scheduling/booking";
import {
  clearHoldCookie,
  readHoldCookie,
} from "@/server/booking/hold-cookie";
import {
  expireCheckoutSession,
  loadCheckoutTarget,
} from "@/server/payments/checkout-session";

/**
 * "I've changed my mind" — the cancel_url of every Checkout Session.
 *
 * ABANDONING CHECKOUT IS NORMAL, NOT AN ERROR. Somebody wanted to check the
 * price again, could not find their card, or decided to ask their partner
 * first. So there is no warning triangle at the other end of this and nothing
 * that reads like a failure: the slot goes back into the day, the customer
 * lands on the picker they came from, and one plain sentence says what
 * happened.
 *
 * A ROUTE HANDLER RATHER THAN A PAGE, because this WRITES. Returning has to
 * release the hold and expire the session, and a page render must never do
 * either — a refresh would repeat it, and Next may render a page more than
 * once. A handler that finishes with a redirect happens exactly once.
 *
 * IT TAKES NO RETURN ADDRESS. The picker's URL is rebuilt from the appointment
 * itself, which means there is no `?return=` for anybody to point somewhere
 * else. An open redirect on a page that has just handled a payment is not a
 * hole worth leaving for the sake of one query parameter.
 */
export const runtime = "nodejs";

export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("slug");

  /* Nothing sensible to return to. The home page is a dead end but an honest
     one, and this is only reachable by hand-editing the URL. */
  if (!slug) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  let destination = bookingUrl(slug);

  const cookie = await readHoldCookie(slug);

  if (cookie) {
    const target = await loadCheckoutTarget(cookie.appointmentId);

    if (target) {
      /* Back to the day they were looking at, with the service and the person
         still chosen, and one sentence about what just happened. */
      destination = bookingUrl(slug, {
        service: target.picker.serviceId,
        staff: target.picker.staffId,
        date: target.picker.date,
        notice: "checkout-cancelled",
      });

      /**
       * KILL THE SESSION BEFORE GIVING THE SLOT BACK.
       *
       * In the other order there is a window — small, but real — where the
       * slot is available to everybody and the abandoned session is still
       * payable. That is precisely the "paid for a slot that had gone" case,
       * and it is much better avoided here than handled later.
       */
      if (target.existingSessionId) {
        await expireCheckoutSession(target.existingSessionId);
      }
    }

    /* Token-checked inside: an appointment id on its own releases nothing. */
    await releaseHoldByToken(db, cookie.appointmentId, cookie.manageToken);
  }

  await clearHoldCookie();

  /* 303, so the browser does a GET to the picker and the back button does not
     offer to repeat this handler. */
  return NextResponse.redirect(new URL(destination, request.url), 303);
}
