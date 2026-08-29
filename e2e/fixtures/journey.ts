import { expect, type Page } from "@playwright/test";

/**
 * The steps every spec walks, and the one thing they all have to survive.
 *
 * ═══ WHY EVERY CLICK IS WRAPPED IN `toPass` ═══
 *
 * The booking flow is Server Components with `<Link>` navigation. Between the
 * server's HTML arriving and React hydrating it, the DOM is replaced — and a
 * click dispatched in that window lands on a node that is about to be detached
 * and is simply lost. Playwright retries a click while an element is unstable,
 * but once the click has been dispatched it considers the job done, so the
 * suite would sit waiting for a navigation that never started.
 *
 * It showed up as the first test in a run failing and the second passing, on a
 * cold server, which is the classic shape of this bug and the classic way to
 * misdiagnose it as "the app is slow".
 *
 * So each step is CLICK PLUS THE EVIDENCE IT WORKED, retried together. That is
 * not papering over flakiness: the assertion is what makes the step meaningful
 * anyway, and a step that never produces its evidence still fails, loudly,
 * with the thing it was waiting for named.
 */

/** How long a step gets to land, across all its retries. */
const STEP_TIMEOUT = 30_000;

/** Click, then require the proof. Retried as one unit. */
async function clickUntil(
  action: () => Promise<void>,
  proof: () => Promise<void>,
): Promise<void> {
  await expect(async () => {
    await action();
    await proof();
  }).toPass({ timeout: STEP_TIMEOUT, intervals: [500, 1000, 2000] });
}

/** Open the business's front page and choose a service by name. */
export async function chooseService(
  page: Page,
  slug: string,
  serviceName: string,
): Promise<void> {
  /**
   * `domcontentloaded`, not the default `load`.
   *
   * The booking page keeps work in flight after the document is usable — the
   * picker polls, fonts settle, the theme toggle hydrates — and waiting for
   * every last resource makes the step's timing depend on things the test is
   * not about. The assertions below wait for what actually matters.
   */
  await page.goto(`/book/${slug}`, { waitUntil: "domcontentloaded" });

  await clickUntil(
    () => page.getByRole("link", { name: new RegExp(serviceName) }).click(),
    () => page.waitForURL(/service=/, { timeout: 5_000 }),
  );
}

/**
 * Choose the first day the month grid says has something free.
 *
 * The grid disables a day with no openings, so "not disabled" is the whole
 * predicate — and it is the application's own answer rather than a date this
 * test worked out for itself.
 */
export async function chooseFirstOpenDay(page: Page): Promise<void> {
  await clickUntil(
    () => page.locator('[role="grid"] button:not([disabled])').first().click(),
    () => page.waitForURL(/date=/, { timeout: 5_000 }),
  );
}

/**
 * Take the first slot on offer, and return the label it was offered under.
 *
 * An open slot is the only pressable thing on the ribbon, and its accessible
 * name is the range, the duration and the word "open" — assembled in
 * ribbon-segment.tsx so a screen reader hears what a sighted person sees. The
 * label comes back so a second browser can be asked whether it is still there.
 */
export async function takeFirstOpenSlot(page: Page): Promise<string> {
  const slot = page.getByRole("button", { name: /, open$/ }).first();

  await expect(slot).toBeVisible();

  const label = (await slot.getAttribute("aria-label")) ?? "";

  await clickUntil(
    () => page.getByRole("button", { name: label, exact: true }).click(),
    /* THE HOLD. A real `held` row the exclusion constraint covers, and the
       countdown is the honest readout of the deadline Postgres wrote. */
    () => expect(page.getByText("Held for you")).toBeVisible({ timeout: 5_000 }),
  );

  return label;
}

/** Move from the picker to the form. */
export async function continueToDetails(page: Page): Promise<void> {
  await clickUntil(
    () => page.getByRole("link", { name: "Continue" }).click(),
    () =>
      expect(
        page.getByRole("heading", { name: "Who is this for?" }),
      ).toBeVisible({ timeout: 5_000 }),
  );
}

/**
 * Fill the form.
 *
 * `exact: true` on every label, because the policy checkbox's accessible name
 * contains the sentences the policy is made of — and one of them mentions an
 * email address, so a loose "Email" matches two controls.
 */
export async function fillDetails(
  page: Page,
  details: { name: string; email: string; phone?: string },
): Promise<void> {
  await page.getByLabel("Name", { exact: true }).fill(details.name);
  await page.getByLabel("Email", { exact: true }).fill(details.email);

  if (details.phone) {
    await page.getByLabel("Phone", { exact: true }).fill(details.phone);
  }
}

/** Tick the cancellation policy. The submit is refused without it. */
export async function acceptPolicy(page: Page): Promise<void> {
  await page
    .getByRole("checkbox", {
      name: /I have read how changing and cancelling works/,
    })
    .check();
}
