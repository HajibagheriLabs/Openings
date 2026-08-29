import { expect, test } from "@playwright/test";

import {
  clearE2eAppointments,
  e2eAppointments,
  e2eDb,
  E2E_SLUG,
  FREE_SERVICE,
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
 * THE MONEY PATH, through a real browser.
 *
 * Open the booking page, pick a service, pick a day, pick a time, watch the
 * hold appear, fill the form, confirm — then check two things that no unit
 * test can check together: that the database says `confirmed`, and that a
 * SECOND BROWSER, which knows nothing about the first, is no longer offered
 * that time.
 *
 * That last assertion is the point of the suite. Everything else here is
 * covered more precisely somewhere in test/ — the constraint under genuine
 * concurrency, the hold's lifecycle, the webhook's idempotency. What only an
 * end-to-end run can show is that all of it is wired together: that the hold
 * the picker writes is the hold the form reads, that the row the form claims
 * is the row the confirmation renders, and that the slot really does leave the
 * page for everybody else.
 *
 * The card itself lives in ./stripe-card.spec.ts, because Stripe's hosted page
 * is not ours and must never be what stops CI going green.
 */

test.beforeEach(async () => {
  /* A fresh diary per test. Two runs an hour apart must not have the second
     one hunting for a slot the first one took. */
  const { db, pool } = e2eDb();

  try {
    await clearE2eAppointments(db);
  } finally {
    await pool.end();
  }
});

test("a customer books a slot, and it is gone for everybody else", async ({
  page,
  browser,
}) => {
  const email = uniqueEmail();

  /* ---- The business's own page ------------------------------------------ */

  await page.goto(`/book/${E2E_SLUG}`, { waitUntil: "domcontentloaded" });

  await expect(
    page.getByRole("heading", { name: "E2E Test Studio", level: 1 }),
  ).toBeVisible();

  /* Rendered from the real availability rules, not from a stored string. */
  await expect(page.getByText("Opening hours")).toBeVisible();

  /* ---- Service, day, time ----------------------------------------------- */

  await chooseService(page, E2E_SLUG, FREE_SERVICE);
  await chooseFirstOpenDay(page);

  /* The address the second browser will be sent to — the same service and the
     same day, with nothing about the first browser's hold in it. */
  const dayUrl = page.url();

  const slotLabel = await takeFirstOpenSlot(page);

  await continueToDetails(page);

  /* ---- Details ----------------------------------------------------------- */

  await fillDetails(page, {
    name: "Sam Taylor",
    email,
    phone: "07700 900123",
  });

  await acceptPolicy(page);

  /* No deposit on this service, so the booking is confirmed inside the same
     transaction that claims the hold. Nothing goes to Stripe. */
  await page.getByRole("button", { name: "Confirm booking" }).click();

  await expect(
    page.getByRole("heading", { name: "You are booked in" }),
  ).toBeVisible({ timeout: 30_000 });

  /* ---- What the database says -------------------------------------------- */

  const { db, pool } = e2eDb();

  try {
    const rows = await e2eAppointments(db);

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("confirmed");
    /* The calendar identity exists from the moment the hold was written, which
       is what lets the manage link work before the confirmation is sent. */
    expect(rows[0].icsUid).toContain("@");
  } finally {
    await pool.end();
  }

  /* ---- A second browser, which knows nothing --------------------------- */

  /**
   * A FRESH CONTEXT, not a fresh page. The hold travels in an httpOnly cookie
   * and the confirmation is resolved from it, so reusing the context would let
   * the second visitor inherit the first one's booking and prove nothing.
   */
  const other = await browser.newContext();
  const second = await other.newPage();

  try {
    await second.goto(dayUrl, { waitUntil: "domcontentloaded" });

    /* Wait for the day to have drawn before asking what is missing from it,
       or "no such button" would be true of a page that had not rendered. */
    await expect(
      second.getByRole("button", { name: /, open$/ }).first(),
    ).toBeVisible();

    /* The exact slot the first browser took is not on offer any more. Every
       other slot on the day still is — this is a booking, not an outage. */
    await expect(
      second.getByRole("button", { name: slotLabel, exact: true }),
    ).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test("the form refuses to submit without the policy box", async ({ page }) => {
  /**
   * THE CLIENT IS NOT THE ENFORCER, and this only proves the client is polite.
   * That the SERVER refuses the same submit is asserted directly in
   * test/5-policy/booking-details.test.ts, where it can be checked without a
   * browser. What this covers is the wiring: that the field is reachable, that
   * it blocks, and that the message lands next to it.
   */
  await chooseService(page, E2E_SLUG, FREE_SERVICE);
  await chooseFirstOpenDay(page);
  await takeFirstOpenSlot(page);
  await continueToDetails(page);

  await fillDetails(page, { name: "Sam Taylor", email: uniqueEmail() });

  await page.getByRole("button", { name: "Confirm booking" }).click();

  await expect(page.getByText(/read how changing and cancelling/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "You are booked in" }),
  ).toHaveCount(0);
});
