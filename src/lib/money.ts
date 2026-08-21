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
 * The deposit a service asks for, in cents.
 *
 * `percent` rounds to the nearest cent and can never exceed the price — a 100%
 * deposit is the full amount, not a rounding artefact one cent above it.
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
