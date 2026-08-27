import { describe, expect, it } from "vitest";

import { depositCentsFor, describeDepositSplit } from "@/lib/money";

/**
 * What the card is charged.
 *
 * ONE IMPLEMENTATION, and this is the file that pins its behaviour: the same
 * function produces the "due now" line on the summary panel, the
 * `deposit_cents` written onto the appointment when the slot is taken, and the
 * `unit_amount` on the Stripe Checkout Session. If those three ever disagreed
 * by a cent, the customer would be shown one number and charged another — and
 * the rounding direction is exactly where that would happen.
 *
 * The rule, stated once: percentages round HALF UP to the whole cent, and the
 * result is capped at the price.
 */

const service = (over: Partial<Parameters<typeof depositCentsFor>[0]> = {}) => ({
  priceCents: 4500,
  depositType: "none" as const,
  depositValue: 0,
  ...over,
});

describe("depositCentsFor", () => {
  it("asks for nothing when the policy is none", () => {
    expect(depositCentsFor(service({ depositType: "none" }))).toBe(0);
  });

  it("takes a flat deposit at face value", () => {
    expect(
      depositCentsFor(service({ depositType: "flat", depositValue: 1500 })),
    ).toBe(1500);
  });

  it("never charges more than the service costs", () => {
    /* The service form refuses a flat deposit above the price, so this is the
       second line of defence — and the one that runs against a row written
       before that rule existed. */
    expect(
      depositCentsFor(
        service({ priceCents: 4500, depositType: "flat", depositValue: 9000 }),
      ),
    ).toBe(4500);
  });

  it("rounds a percentage half UP, so the business is never a cent short", () => {
    /* 4990 × 25% = 1247.5 cents exactly. Half up is 1248. This is the case
       that would silently differ between two implementations. */
    expect(
      depositCentsFor(
        service({ priceCents: 4990, depositType: "percent", depositValue: 25 }),
      ),
    ).toBe(1248);
  });

  it("rounds a percentage that lands below the half down", () => {
    /* 3333 × 15% = 499.95 → 500. Nearest, not always up. */
    expect(
      depositCentsFor(
        service({ priceCents: 3333, depositType: "percent", depositValue: 15 }),
      ),
    ).toBe(500);
  });

  it("makes 100% exactly the price, not a cent above it", () => {
    expect(
      depositCentsFor(
        service({ priceCents: 4501, depositType: "percent", depositValue: 100 }),
      ),
    ).toBe(4501);
  });

  it("returns whole cents for every percentage of every price", () => {
    /* A fractional cent cannot be charged, and Stripe rejects one outright.
       This is the property, not an example of it. */
    for (let price = 0; price <= 20_000; price += 137) {
      for (let percent = 1; percent <= 100; percent += 7) {
        const cents = depositCentsFor(
          service({
            priceCents: price,
            depositType: "percent",
            depositValue: percent,
          }),
        );

        expect(Number.isInteger(cents)).toBe(true);
        expect(cents).toBeGreaterThanOrEqual(0);
        expect(cents).toBeLessThanOrEqual(price);
      }
    }
  });
});

describe("describeDepositSplit", () => {
  it("says what leaves now and what to bring", () => {
    expect(
      describeDepositSplit(
        service({ priceCents: 6000, depositType: "flat", depositValue: 1500 }),
        "EUR",
      ),
    ).toBe("€15.00 deposit, €45.00 on the day");
  });

  it("does not invite somebody to work out that nothing is left", () => {
    expect(
      describeDepositSplit(
        service({ priceCents: 6000, depositType: "percent", depositValue: 100 }),
        "EUR",
      ),
    ).toBe("€60.00 paid now");
  });

  it("is absent rather than the word none", () => {
    expect(describeDepositSplit(service(), "EUR")).toBeNull();
  });
});
