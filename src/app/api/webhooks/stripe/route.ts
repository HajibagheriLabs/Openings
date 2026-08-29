import { NextResponse } from "next/server";
import type Stripe from "stripe";

import { serverEnv } from "@/env.server";
import { getStripe } from "@/lib/payments/stripe";
import { handleStripeEvent } from "@/server/payments/webhook";

/**
 * The only place an appointment becomes `confirmed` after a payment.
 *
 * FOUR RULES, AND THREE OF THEM ARE ABOUT NOT TRUSTING THE REQUEST.
 *
 * 1. NODE RUNTIME. Signature verification needs Node's crypto, and the
 *    database work behind it needs a real pooled connection with real
 *    transactions. The Edge runtime gives neither.
 *
 * 2. THE RAW BODY, UNPARSED. `constructEvent` recomputes an HMAC over the
 *    exact bytes Stripe signed. `await req.json()` would parse and re-serialise
 *    them, and a re-serialised object is not byte-identical — different key
 *    order, different number formatting, different escaping — so every
 *    signature would fail for a reason that looks like a bad secret. Read the
 *    text, verify the text, and only then look inside it.
 *
 * 3. A SIGNATURE IS NOT OWNERSHIP. The signing secret belongs to a Stripe
 *    ACCOUNT, and this project shares a test-mode account with another one, so
 *    that other project's events arrive here perfectly signed. Deciding whose
 *    an event is happens in `handleStripeEvent`, against the `app: openings`
 *    tag on the object. Verification only answers "did Stripe send this?".
 *
 * 4. ANSWER 200 UNLESS WE WANT IT AGAIN. Stripe retries any non-2xx for days.
 *    A bad signature is 400 because retrying it is pointless and it should show
 *    up as a failure. Everything else — a duplicate, a stranger's event, even
 *    one naming an appointment that does not exist — gets a 200, because
 *    redelivering it will not change the answer. The unresolvable ones are
 *    logged loudly instead.
 *
 * The handler itself stays small and does no I/O beyond the database. Nothing
 * is emailed here; messages become rows in `notifications` and a worker sends
 * them. See the note in `confirmPaidHold`.
 */
export const runtime = "nodejs";

/* A webhook is never cached, never prerendered, and never revalidated. */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const stripe = getStripe();
  const secret = serverEnv.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !secret) {
    /**
     * Not configured. 500 rather than 200, because this is the one failure
     * Stripe SHOULD retry: it is our end that is misconfigured, the event is
     * perfectly good, and a redelivery after the key is set will work.
     */
    console.error(
      "[stripe] a webhook arrived but STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET is not set.",
    );

    return NextResponse.json({ error: "not configured" }, { status: 500 });
  }

  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "missing signature" }, { status: 400 });
  }

  /* RAW. See rule 2 above — do not parse this first. */
  const payload = await request.text();

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(payload, signature, secret);
  } catch (error) {
    /* An unsigned or tampered request, or a secret that does not match the
       endpoint. Never retryable, and worth seeing. */
    console.warn(
      "[stripe] rejected a webhook with an invalid signature:",
      error instanceof Error ? error.message : error,
    );

    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  try {
    const outcome = await handleStripeEvent(event);

    if (outcome.status === "handled") {
      console.info(`[stripe] ${event.type}: ${outcome.detail}`);
    }

    return NextResponse.json({ received: true, status: outcome.status });
  } catch (error) {
    /**
     * The database was unreachable, or something genuinely broke.
     *
     * 500, so Stripe retries — this is the one case where a redelivery is
     * exactly what we want. `handleStripeEvent` has already released the
     * idempotency guard for this event id on its way out, so the retry is
     * processed rather than swallowed as a duplicate.
     */
    console.error(`[stripe] failed to handle ${event.type} (${event.id})`, error);

    return NextResponse.json({ error: "handler failed" }, { status: 500 });
  }
}
