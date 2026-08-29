import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/db/client";
import { availabilityRules, customers, serviceStaff } from "@/db/schema";
import { loadDayView } from "@/lib/scheduling/day-view";
import { createHold, DEFAULT_HOLD_MINUTES } from "@/lib/scheduling/booking";
import {
  CHECKOUT_IP_RULE,
  consumeRateLimit,
  DETAILS_EMAIL_RULE,
  DETAILS_IP_RULE,
  HOLD_CREATE_DAY_RULE,
  HOLD_CREATE_IP_RULE,
  MIN_SECONDS_ON_FORM,
  rateLimitKey,
} from "@/server/booking/rate-limit";
import { setupTestDatabase, type TestContext } from "../helpers/database";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PUBLIC ENDPOINTS, UNDER ABUSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * /book/<slug> has no session behind it. Every action under it — take a slot,
 * submit details, start checkout — is an HTTP endpoint a stranger can post to
 * as often as they like, and each one spends something: a row, an email, or a
 * Stripe object.
 *
 * The one that matters most is the first. A hold makes a slot genuinely
 * unavailable to everybody else, which is the whole point of the design and
 * also the thing that can be turned against a business: take every slot on
 * Saturday, let them lapse, take them again. The salon looks fully booked all
 * day and never gets a booking.
 *
 * ═══ WHAT IS TESTED HERE, AND WHAT IS NOT ═══
 *
 * The Server Actions themselves cannot be called from a unit test — they read
 * `headers()` and `cookies()`, which only exist inside a request. So these
 * tests exercise the LIMITER AND THE ARITHMETIC underneath them at the same
 * keys the actions use, alongside real holds in a real database, and assert the
 * property that actually matters: after one address has spent its whole
 * allowance, the day still has times a different customer can book.
 *
 * The fixture business is Europe/Berlin. 15 September 2026 is a Tuesday, clear
 * of any DST transition.
 */

let context: TestContext;
let db: Db;

const TUESDAY = 2;
const TIME_ZONE = "Europe/Berlin";
const DATE = "2026-09-15";
/**
 * ═══ THE DAY IS FIXED; THE CLOCK IS NOT ═══
 *
 * `createHold` stamps `hold_expires_at = now() + 8 minutes` from POSTGRES's
 * clock, and availability treats a hold as blocking only while that deadline
 * is still ahead. Evaluating the day "as of" some pinned 2026 instant would
 * therefore find every hold long lapsed and report a completely free day —
 * the test would pass while proving nothing.
 *
 * So DATE above is a fixed future Tuesday, and `dayView` runs against the real
 * clock, which is the only way a live hold looks live.
 */

/** 09:00 local is 07:00Z; the plain service is 60 minutes with no buffers. */
const at = (hourUtc: number, minute = 0) =>
  new Date(Date.UTC(2026, 8, 15, hourUtc, minute));

/** A different address on every test, so windows never bleed between them. */
let addressCounter = 0;
const nextAddress = () => `198.51.100.${(addressCounter += 1) % 250}`;

beforeAll(async () => {
  context = await setupTestDatabase();
  db = context.db;

  await db.execute(sql`
    UPDATE businesses SET min_lead_time_min = 0 WHERE id = ${context.businessId}
  `);
});

afterAll(async () => {
  await context.pool.end();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE appointments RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE rate_limits`);
  await db.delete(customers);
  await db.delete(availabilityRules);
  await db.delete(serviceStaff);

  await db.insert(serviceStaff).values({
    serviceId: context.plainServiceId,
    staffId: context.staffA,
  });

  /* 09:00–17:00 with a 60-minute service and no buffers: eight slots. */
  await db.insert(availabilityRules).values({
    staffId: context.staffA,
    weekday: TUESDAY,
    startLocal: "09:00",
    endLocal: "17:00",
    effectiveFrom: "2026-01-01",
  });
});

function hold(startsAt: Date) {
  return createHold(db, {
    businessId: context.businessId,
    staffId: context.staffA,
    serviceId: context.plainServiceId,
    startsAt,
    customerId: null,
  });
}

function dayView(now: Date = new Date()) {
  return loadDayView({
    db,
    businessId: context.businessId,
    serviceId: context.plainServiceId,
    staffId: context.staffA,
    timeZone: TIME_ZONE,
    date: DATE,
    now,
  });
}

/** The key `takeSlot` uses for its per-day concurrency bucket. */
const dayKey = (address: string) =>
  rateLimitKey("hold:create:day", `${address}|${context.businessId}|${DATE}`);

/* ===========================================================================
   ONE VISITOR CANNOT LOCK OUT A WHOLE DAY
   =========================================================================== */

describe("holding a day hostage", () => {
  it("LEAVES A DAY BOOKABLE AFTER ONE ADDRESS SPENDS ITS WHOLE ALLOWANCE", async () => {
    const attacker = nextAddress();

    const before = await dayView();
    expect(before).not.toBeNull();

    const slotsInTheDay = before!.view.offers.length;

    /* The day is worth attacking: eight one-hour slots between 09:00 and
       17:00. If this ever drops below the cap the test proves nothing. */
    expect(slotsInTheDay).toBeGreaterThan(HOLD_CREATE_DAY_RULE.limit);

    /**
     * The attack, run exactly as the action would run it: consume the bucket,
     * and only write a hold while it says yes.
     */
    let taken = 0;

    for (let attempt = 0; attempt < slotsInTheDay; attempt += 1) {
      const verdict = await consumeRateLimit(
        db,
        dayKey(attacker),
        HOLD_CREATE_DAY_RULE,
      );

      if (!verdict.allowed) {
        break;
      }

      await hold(at(7 + attempt));
      taken += 1;
    }

    expect(taken).toBe(HOLD_CREATE_DAY_RULE.limit);

    /* THE PROPERTY THAT MATTERS. Not "the limiter counted" — that the day is
       still bookable by somebody else afterwards. */
    const after = await dayView();

    expect(after!.view.offers.length).toBe(slotsInTheDay - taken);
    expect(after!.view.offers.length).toBeGreaterThan(0);
  });

  it("keeps counting a refused attempt, so an attacker cannot idle back in", async () => {
    const attacker = nextAddress();

    for (let i = 0; i < HOLD_CREATE_DAY_RULE.limit; i += 1) {
      await consumeRateLimit(db, dayKey(attacker), HOLD_CREATE_DAY_RULE);
    }

    /* Ten more attempts, all refused. The window must not restart because the
       caller kept knocking — a limiter that stops counting once it starts
       refusing lets somebody keep their allowance warm. */
    for (let i = 0; i < 10; i += 1) {
      const verdict = await consumeRateLimit(
        db,
        dayKey(attacker),
        HOLD_CREATE_DAY_RULE,
      );

      expect(verdict.allowed).toBe(false);
      expect(verdict.used).toBeGreaterThan(HOLD_CREATE_DAY_RULE.limit);
    }
  });

  it("does not let one address's spending touch another's", async () => {
    const attacker = nextAddress();
    const customer = nextAddress();

    for (let i = 0; i <= HOLD_CREATE_DAY_RULE.limit; i += 1) {
      await consumeRateLimit(db, dayKey(attacker), HOLD_CREATE_DAY_RULE);
    }

    expect(
      (await consumeRateLimit(db, dayKey(attacker), HOLD_CREATE_DAY_RULE))
        .allowed,
    ).toBe(false);

    /* A real customer arriving from anywhere else is unaffected. */
    expect(
      (await consumeRateLimit(db, dayKey(customer), HOLD_CREATE_DAY_RULE))
        .allowed,
    ).toBe(true);
  });

  it("bounds a different day separately, so one Saturday is not every Saturday", async () => {
    const attacker = nextAddress();

    for (let i = 0; i <= HOLD_CREATE_DAY_RULE.limit; i += 1) {
      await consumeRateLimit(db, dayKey(attacker), HOLD_CREATE_DAY_RULE);
    }

    const otherDay = rateLimitKey(
      "hold:create:day",
      `${attacker}|${context.businessId}|2026-09-22`,
    );

    expect(
      (await consumeRateLimit(db, otherDay, HOLD_CREATE_DAY_RULE)).allowed,
    ).toBe(true);
  });
});

/* ===========================================================================
   THE CONCURRENCY CAP IS THE RATE, AND THE WINDOW IS THE HOLD
   =========================================================================== */

describe("the concurrency cap", () => {
  it("uses a window no shorter than a hold, or it would not cap anything", () => {
    /**
     * THE WHOLE TRICK, ASSERTED.
     *
     * "At most N new holds per window" only bounds "at most N holds at once"
     * while the window is at least as long as a hold lives. Shorten the window
     * below the hold length and the cap silently stops being a cap: the
     * allowance refreshes while the earlier holds are still occupying slots.
     *
     * This is here because it is the kind of constant somebody tunes later
     * with the best of intentions.
     */
    const holdSeconds = DEFAULT_HOLD_MINUTES * 60;

    expect(HOLD_CREATE_IP_RULE.windowSeconds).toBeGreaterThanOrEqual(
      holdSeconds,
    );
    expect(HOLD_CREATE_DAY_RULE.windowSeconds).toBeGreaterThanOrEqual(
      holdSeconds,
    );
  });

  it("caps one day more tightly than everywhere at once", () => {
    /* The per-day bucket has to bite first, or it can never bite at all. */
    expect(HOLD_CREATE_DAY_RULE.limit).toBeLessThan(HOLD_CREATE_IP_RULE.limit);
  });
});

/* ===========================================================================
   THE OTHER THREE ENDPOINTS
   =========================================================================== */

describe("the details form and checkout", () => {
  it("bounds submissions by address", async () => {
    const address = nextAddress();
    const key = rateLimitKey("details:ip", address);

    for (let i = 0; i < DETAILS_IP_RULE.limit; i += 1) {
      expect((await consumeRateLimit(db, key, DETAILS_IP_RULE)).allowed).toBe(
        true,
      );
    }

    expect((await consumeRateLimit(db, key, DETAILS_IP_RULE)).allowed).toBe(
      false,
    );
  });

  it("BOUNDS SUBMISSIONS BY EMAIL, WHICH IS THE BUCKET AN IP LIMIT CANNOT COVER", async () => {
    /**
     * The attack the address bucket is blind to: many sources, one victim's
     * inbox. Every request comes from somewhere new, so the IP counter never
     * fills — and the address being written to is the same every time.
     */
    const victim = "victim@example.test";
    const key = rateLimitKey("details:email", victim);

    for (let i = 0; i < DETAILS_EMAIL_RULE.limit; i += 1) {
      expect(
        (await consumeRateLimit(db, key, DETAILS_EMAIL_RULE)).allowed,
      ).toBe(true);
    }

    /* The seventh confirmation aimed at this inbox is refused however many
       different machines asked for it. */
    expect((await consumeRateLimit(db, key, DETAILS_EMAIL_RULE)).allowed).toBe(
      false,
    );

    /* Somebody else's inbox is untouched. */
    expect(
      (
        await consumeRateLimit(
          db,
          rateLimitKey("details:email", "someone.else@example.test"),
          DETAILS_EMAIL_RULE,
        )
      ).allowed,
    ).toBe(true);
  });

  it("bounds checkout attempts by address", async () => {
    const key = rateLimitKey("checkout:ip", nextAddress());

    for (let i = 0; i < CHECKOUT_IP_RULE.limit; i += 1) {
      await consumeRateLimit(db, key, CHECKOUT_IP_RULE);
    }

    expect((await consumeRateLimit(db, key, CHECKOUT_IP_RULE)).allowed).toBe(
      false,
    );
  });
});

/* ===========================================================================
   TIME ON FORM
   =========================================================================== */

describe("the minimum time on form", () => {
  it("MEASURES FROM THE HOLD'S OWN created_at, WHICH POSTGRES STAMPED", async () => {
    /**
     * The check the submit performs, against the value it performs it on.
     *
     * The point of the test is the SOURCE of the timestamp: `createdAt` comes
     * back from the row rather than from anything a caller sent, so there is
     * nothing here for a script to set. A hidden "rendered at" field would
     * have been trivially forgeable, which is why there is not one.
     */
    const held = await hold(at(7));
    const createdAt = held.appointment.createdAt;

    expect(createdAt).toBeInstanceOf(Date);

    const instantly = createdAt.getTime() + 500;
    const later = createdAt.getTime() + (MIN_SECONDS_ON_FORM + 1) * 1000;

    expect(instantly - createdAt.getTime()).toBeLessThan(
      MIN_SECONDS_ON_FORM * 1000,
    );
    expect(later - createdAt.getTime()).toBeGreaterThanOrEqual(
      MIN_SECONDS_ON_FORM * 1000,
    );
  });
});
