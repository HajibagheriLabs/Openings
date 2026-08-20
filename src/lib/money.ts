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

/** Cents to a display string, in the business's currency. */
export function formatCents(
  cents: number,
  currency: string,
  locale?: string,
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
