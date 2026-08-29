import "server-only";

import Stripe from "stripe";

import { serverEnv } from "@/env.server";

/**
 * The payments boundary — the only module that constructs a Stripe client.
 *
 * The same shape as the mailer: one accessor, and an implementation that
 * depends on whether the key is set. `getStripe()` returns null when
 * STRIPE_SECRET_KEY is absent, and every caller has to say what it does about
 * that. Nothing in this project may assume Stripe is configured, because the
 * whole product is meant to run on a laptop with nothing but a database — see
 * the note on the no-deposit path in src/server/actions/details.ts.
 *
 * TEST MODE ONLY. This project never activates a Stripe account, and
 * `assertTestMode` below refuses to start with a live key rather than letting
 * a portfolio demo charge somebody's real card. There is no configuration that
 * turns that off.
 */

/**
 * The API version this code was written against, pinned explicitly.
 *
 * The SDK sends its own pinned version by default, so passing it changes
 * nothing today. It is here so the upgrade is a deliberate edit with a diff to
 * read, rather than a `npm update` that silently moves the shape of every
 * object this app parses.
 */
export const STRIPE_API_VERSION = "2026-08-26.dahlia" as const;

/** One client per process. The SDK keeps a keep-alive agent behind it. */
const globalForStripe = globalThis as unknown as { __openingsStripe?: Stripe };

/**
 * The Stripe client, or null when no key is configured.
 *
 * Callers that need a client and cannot proceed without one should use
 * `requireStripe()`. Callers deciding whether to OFFER card payment at all
 * should use `isStripeConfigured()` — the difference matters, because the
 * booking flow degrades rather than breaking.
 */
export function getStripe(): Stripe | null {
  const key = serverEnv.STRIPE_SECRET_KEY;

  if (!key) {
    return null;
  }

  assertTestMode(key);

  return (globalForStripe.__openingsStripe ??= new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    typescript: true,
    /**
     * Named so this application's requests are identifiable in the Stripe
     * dashboard's logs. That is not cosmetic here: this project is expected to
     * share a test-mode account with other work, and "which app made this
     * charge" is otherwise a guess. The webhook applies the same reasoning
     * with metadata — see OWNER_TAG in ./checkout.ts.
     */
    appInfo: {
      name: "Openings",
      url: "https://github.com/",
    },
    /* Two retries rather than the default one. Creating a Checkout Session
       sits in the middle of a booking with a hold running against it, and a
       single transient network blip should not cost the customer their slot.
       The SDK attaches idempotency keys to retried writes itself. */
    maxNetworkRetries: 2,
  }));
}

/** The client, or a loud failure. For code that has already decided it needs one. */
export function requireStripe(): Stripe {
  const stripe = getStripe();

  if (!stripe) {
    throw new Error(
      "Stripe is not configured: set STRIPE_SECRET_KEY in .env.local.",
    );
  }

  return stripe;
}

/** Whether card payment can be offered at all. */
export function isStripeConfigured(): boolean {
  return Boolean(serverEnv.STRIPE_SECRET_KEY);
}

/**
 * Refuse a live key.
 *
 * A portfolio project has no business holding one, and the failure mode of
 * getting this wrong — a demo booking charging a real card — is not one to
 * leave to discipline. Restricted test keys (`rk_test_`) are allowed for the
 * same reason `sk_test_` is.
 */
function assertTestMode(key: string): void {
  if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) {
    throw new Error(
      "STRIPE_SECRET_KEY is not a test key. This project runs in Stripe test " +
        "mode only — use the key that starts with sk_test_.",
    );
  }
}
