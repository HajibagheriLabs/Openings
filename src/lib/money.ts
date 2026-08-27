/**
 * Money is integer cents everywhere in this project. This module is the only
 * place a human-typed amount becomes one.
 *
 * The parse never touches a float. `parseFloat("19.99") * 100` is 1998.9999…
 * on a good day, and rounding that is a bug waiting for a specific price to
 * trigger it. Splitting the string and padding the fraction cannot drift.
 */

/** Up to 7 whole digits, optional 1–2 decimals, comma or point. */
const MONEY_PATTERN = /^\d{1,7}(?:[.,]\d{1,2})?$/;

/** Returns cents, or null when the input is not an amount. */
export function parseMoneyToCents(input: string): number | null {
  const trimmed = input.trim();

  if (!MONEY_PATTERN.test(trimmed)) {
    return null;
  }

  const [whole, fraction = ""] = trimmed.replace(",", ".").split(".");

  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/**
 * Cents back into the plain string the price input edits.
 *
 * The exact inverse of `parseMoneyToCents`, and the only correct way to
 * populate an edit form: reading a price out of the database and rendering it
 * with a currency formatter would put a symbol and a thousands separator into
 * a field that then refuses to parse.
 */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Pinned, not the visitor's locale — the same hazard as DEFAULT_TIME_LOCALE.
 *
 * A Server Component and the browser that hydrates it must produce identical
 * text. `undefined` resolves to the server's locale on one side and the
 * visitor's on the other, so "€45.00" and "45,00 €" disagree and React tears
 * the tree down. Pass a locale explicitly on a surface that genuinely wants
 * the visitor's conventions, and render that surface on the client.
 */
export const DEFAULT_MONEY_LOCALE = "en-GB";

/** Cents to a display string, in the business's currency. */
export function formatCents(
  cents: number,
  currency: string,
  locale: string = DEFAULT_MONEY_LOCALE,
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(cents / 100);
}

/**
 * THE deposit a service asks for, in integer cents. One implementation.
 *
 * Every number that reaches a customer or a card comes through here: the price
 * line on the picker, the "due now" row in the summary, the amount written
 * onto the appointment when the hold is taken, and the `unit_amount` on the
 * Stripe Checkout Session. A second implementation anywhere would eventually
 * differ by a cent on some percentage, and that is the class of bug exactly
 * one customer notices and nobody believes.
 *
 * ROUNDING DIRECTION, STATED: `percent` rounds HALF UP to the nearest whole
 * cent. `Math.round` in JavaScript rounds .5 away from zero for positive
 * numbers, and every input here is non-negative, so a 12.5-cent deposit is 13
 * — the business is never a cent short, and the customer is never asked for a
 * fraction of a cent that cannot be charged. The difference is at most one
 * cent on one line; the point is that it is decided in one place rather than
 * per caller.
 *
 * CAPPED AT THE PRICE, always. A 100% deposit is the full amount and not a
 * rounding artefact a cent above it, and a flat deposit an owner typed larger
 * than the price cannot charge more than the service costs. The service form
 * already refuses both, so this is the second line of defence rather than the
 * first — but it is the line that runs against rows written before a rule
 * existed.
 */
export function depositCentsFor(service: {
  priceCents: number;
  depositType: "none" | "flat" | "percent";
  depositValue: number;
}): number {
  switch (service.depositType) {
    case "none":
      return 0;
    case "flat":
      return Math.min(service.depositValue, service.priceCents);
    case "percent":
      return Math.min(
        Math.round((service.priceCents * service.depositValue) / 100),
        service.priceCents,
      );
  }
}

/**
 * The deposit policy in words, for a list row.
 *
 * A percentage is shown WITH the amount it works out to. "20%" is a policy;
 * "20% (9.00)" is what the customer's card is actually charged, and the owner
 * setting the policy is entitled to see both without doing the arithmetic.
 * Returns null when there is no deposit — an absent fact, not the word "none".
 */
export function describeDeposit(
  service: {
    priceCents: number;
    depositType: "none" | "flat" | "percent";
    depositValue: number;
  },
  currency: string,
  locale: string = DEFAULT_MONEY_LOCALE,
): string | null {
  const cents = depositCentsFor(service);

  switch (service.depositType) {
    case "none":
      return null;
    case "flat":
      return `${formatCents(cents, currency, locale)} deposit`;
    case "percent":
      return `${service.depositValue}% deposit (${formatCents(cents, currency, locale)})`;
  }
}

/**
 * What the customer actually pays, and when: "£15 deposit, £45 on the day".
 *
 * Deliberately different from `describeDeposit` above, which is for the OWNER
 * setting a policy and therefore names the policy ("20% deposit (£9.00)"). A
 * customer does not care that the number came from a percentage; they care
 * what leaves their account now and what they bring with them. Two audiences,
 * two sentences, one calculation underneath.
 *
 * Returns null when there is no deposit — an absent fact rather than the word
 * "none", so the caller can simply omit the line.
 */
export function describeDepositSplit(
  service: {
    priceCents: number;
    depositType: "none" | "flat" | "percent";
    depositValue: number;
  },
  currency: string,
  locale: string = DEFAULT_MONEY_LOCALE,
): string | null {
  const deposit = depositCentsFor(service);

  if (deposit <= 0) {
    return null;
  }

  const balance = service.priceCents - deposit;

  /* A deposit equal to the price is not a deposit, it is the bill. Saying
     "£45 deposit, £0 on the day" invites the reader to work out that there is
     nothing left, which is a question they should never have been asked. */
  if (balance <= 0) {
    return `${formatCents(deposit, currency, locale)} paid now`;
  }

  return `${formatCents(deposit, currency, locale)} deposit, ${formatCents(
    balance,
    currency,
    locale,
  )} on the day`;
}

/** ISO 4217 codes offered during onboarding. Editable later in settings. */
export const CURRENCIES = [
  { code: "EUR", label: "Euro" },
  { code: "USD", label: "US dollar" },
  { code: "GBP", label: "Pound sterling" },
  { code: "CHF", label: "Swiss franc" },
  { code: "SEK", label: "Swedish krona" },
  { code: "NOK", label: "Norwegian krone" },
  { code: "DKK", label: "Danish krone" },
  { code: "PLN", label: "Polish zloty" },
  { code: "CAD", label: "Canadian dollar" },
  { code: "AUD", label: "Australian dollar" },
] as const;

export type CurrencyCode = (typeof CURRENCIES)[number]["code"];
