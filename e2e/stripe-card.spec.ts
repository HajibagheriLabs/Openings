import { createHmac } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import Stripe from "stripe";

import {
  clearE2eAppointments,
  DEPOSIT_SERVICE,
  e2eAppointments,
  e2eDb,
  E2E_SLUG,
  uniqueEmail,
} from "./fixtures/database";
import {
  acceptPolicy,
  chooseFirstOpenDay,
  chooseService,
  continueToDetails,
  fillDetails,
  takeFirstOpenSlot,
} from "./fixtures/journey";

/**
 * PAYING WITH THE STRIPE TEST CARD, on Stripe's own hosted page.
 *
 * ═══ WHY THIS IS A SEPARATE FILE, AND SKIPPED WITHOUT KEYS ═══
 *
 * Two reasons, and neither is squeamishness:
 *
 *   1. CREDENTIALS. Driving this needs a Stripe secret key. CI should not hold
 *      one for a portfolio project, and a suite that went red on every fork
 *      and every pull request from outside would be a suite people learn to
 *      ignore. So it skips, loudly, with the reason printed.
 *
 *   2. IT IS NOT OUR PAGE. Stripe redesigns Checkout whenever they like. A
 *      selector breaking there says nothing about this application, and it
 *      must never be the thing that stops a release.
 *
 * WHAT IS NOT SKIPPED ANYWHERE is the part that actually confirms a booking.
 * `checkout.session.completed` — arriving twice, arriving unsigned, arriving
 * after the slot has gone, arriving for an appointment that no longer exists —
 * is covered exhaustively in test/3-payments against a real database. This
 * spec exists to prove the hop between the two: that the session the app
 * creates is the session Stripe charges, and that the webhook it produces
 * confirms the row the browser is looking at.
 *
 * ═══ THE FORWARDER ═══
 *
 * Stripe cannot reach 127.0.0.1, which is why a developer runs
 * `stripe listen --forward-to localhost:3000/api/webhooks/stripe`. This does
 * the same job in twenty lines: retrieve the paid session over the API, wrap
 * it in an event envelope, sign it with the LOCAL webhook secret, and POST it.
 * The signature is computed the way Stripe computes it, so the route's
 * `constructEvent` verifies it exactly as it verifies a real delivery — no
 * bypass, no test-only branch in the application.
 */

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const configured = Boolean(STRIPE_KEY && WEBHOOK_SECRET);

test.skip(
  !configured,
  "STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are not set — the card path " +
    "needs both. The webhook itself is covered by test/3-payments.",
);

/** Stripe's published test card. Nothing else works, and nothing real does. */
const TEST_CARD = {
  number: "4242 4242 4242 4242",
  expiry: "12 / 34",
  cvc: "123",
  postcode: "12345",
} as const;

/**
 * One event, signed the way Stripe signs one.
 *
 * `t=<unix>,v1=<hmac of "t.payload">` — the scheme the SDK verifies. Building
 * it here rather than reaching for a helper keeps it obvious that the route is
 * being tested through its real signature check.
 */
async function forwardWebhook(session: Stripe.Checkout.Session, baseUrl: string) {
  const event = {
    id: `evt_e2e_${Date.now()}`,
    object: "event",
    api_version: null,
    created: Math.floor(Date.now() / 1000),
    type: "checkout.session.completed",
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object: session },
  };

  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", WEBHOOK_SECRET!)
    .update(`${timestamp}.${payload}`)
    .digest("hex");

  const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${signature}`,
    },
    body: payload,
  });

  expect(response.status, await response.text()).toBe(200);
}

/**
 * Fill Stripe's card form.
 *
 * DELIBERATELY TOLERANT, because none of this markup is ours and what appears
 * depends on the account's settings, the currency and the country: a euro
 * session offers Bancontact, MB WAY, EPS and Satispay alongside the card, and
 * the card fields do not exist until Card is chosen. Every step below is
 * therefore conditional — present it, use it; absent, move on.
 */
async function payOnStripe(page: Page): Promise<void> {
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 });

  const cardNumber = page.getByRole("textbox", { name: "Card number" });

  /**
   * GET TO THE CARD FORM, retrying the whole approach until it is on screen.
   *
   * Two things stand in the way and both arrive asynchronously, which is why
   * this is a loop rather than a sequence:
   *
   *   LINK. "Save my information for faster checkout" is ticked by default,
   *   and while it is ticked Stripe shows Link's express flow — a phone number
   *   and a "Book" button — instead of a card form. It renders after the rest
   *   of the page, so a single check-and-uncheck can run before the box
   *   exists, find nothing, and move on.
   *
   *   THE PAYMENT METHOD. A euro session offers Bancontact, MB WAY, EPS and
   *   Satispay alongside the card, and the card fields do not exist until Card
   *   is chosen. `force` is needed because the row's radio sits under a
   *   full-width button that swallows the pointer.
   *
   * Neither is our markup and neither is stable, so the assertion is the goal
   * — the card number field being present — and everything above it is a means
   * that gets tried again until the goal is met.
   */
  await expect(async () => {
    const saveDetails = page.getByRole("checkbox", {
      name: /Save my information/,
    });

    if ((await saveDetails.count()) && (await saveDetails.first().isChecked())) {
      await saveDetails.first().uncheck();
    }

    const cardOption = page.getByRole("radio", { name: "Card", exact: true });

    if (
      !(await cardNumber.isVisible().catch(() => false)) &&
      (await cardOption.count())
    ) {
      await cardOption.first().check({ force: true });
    }

    await expect(cardNumber).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000, intervals: [500, 1_000, 2_000] });

  await cardNumber.fill(TEST_CARD.number);
  await page.getByRole("textbox", { name: "Expiration" }).fill(TEST_CARD.expiry);
  await page.getByRole("textbox", { name: "CVC" }).fill(TEST_CARD.cvc);

  /* Both depend on the account's settings and the billing country, so both
     are filled only if Stripe asked for them. */
  await fillIfPresent(
    page.getByRole("textbox", { name: "Cardholder name" }),
    "Sam Taylor",
  );
  await fillIfPresent(
    page.getByRole("textbox", { name: /ZIP|Postal code/ }),
    TEST_CARD.postcode,
  );

  await page.getByTestId("hosted-payment-submit-button").click();
}

/** Fill a field that may not be on the page at all. */
async function fillIfPresent(
  locator: ReturnType<Page["getByRole"]>,
  value: string,
): Promise<void> {
  if (await locator.count()) {
    await locator.first().fill(value);
  }
}

test.beforeEach(async () => {
  const { db, pool } = e2eDb();

  try {
    await clearE2eAppointments(db);
  } finally {
    await pool.end();
  }
});

test("a deposit is charged and the webhook confirms the booking", async ({
  page,
  baseURL,
}) => {
  const email = uniqueEmail();

  await chooseService(page, E2E_SLUG, DEPOSIT_SERVICE);
  await chooseFirstOpenDay(page);
  await takeFirstOpenSlot(page);
  await continueToDetails(page);

  await fillDetails(page, { name: "Sam Taylor", email });
  await acceptPolicy(page);

  /* 20% of €100. The button says the amount, because nobody should press a
     pay button that does not name what it is about to take. */
  await page
    .getByRole("button", { name: /^Pay .* deposit$/ })
    .click();

  await payOnStripe(page);

  /**
   * BACK ON OUR SIDE, AND NOT YET BOOKED.
   *
   * A redirect is a browser navigation and proves nothing. The application
   * says so on this screen and waits for the webhook, which is the only thing
   * allowed to confirm an appointment.
   */
  await page.waitForURL(/step=confirming/, { timeout: 60_000 });

  const stripe = new Stripe(STRIPE_KEY!);
  const sessionId = new URL(page.url()).searchParams.get("session");

  expect(sessionId).toBeTruthy();

  const session = await stripe.checkout.sessions.retrieve(sessionId!);

  expect(session.payment_status).toBe("paid");

  await forwardWebhook(session, baseURL!);

  /* The confirming screen polls the row, so it turns over on its own once the
     webhook has committed. */
  await expect(
    page.getByRole("heading", { name: "You are booked in" }),
  ).toBeVisible({ timeout: 60_000 });

  const { db, pool } = e2eDb();

  try {
    const rows = await e2eAppointments(db);

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("confirmed");
  } finally {
    await pool.end();
  }
});
