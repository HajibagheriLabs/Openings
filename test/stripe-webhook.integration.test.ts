import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { Db } from "@/db/client";
import {
  appointments,
  availabilityRules,
  notifications,
  serviceStaff,
  webhookEvents,
} from "@/db/schema";
import type { SlotLostPayload } from "@/lib/notifications/payload";
import { CHECKOUT_METADATA, OWNER_TAG } from "@/lib/payments/checkout";
import {
  CANCELLATION_REASON,
  createHold,
  reclaimExpiredHolds,
} from "@/lib/scheduling/booking";

import {
  at,
  expireHold,
  requireTestDatabaseUrl,
  setupTestDatabase,
  type TestContext,
} from "./helpers/database";

/**
 * The webhook, end to end, against a real database and a mocked Stripe.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT, deliberately:
 *
 *  - The ROUTE is real. These tests POST a `Request` at the exported handler,
 *    so the raw-body read, the signature check and the status codes are the
 *    ones production runs.
 *  - SIGNATURES are real. Stripe's own `generateTestHeaderString` signs each
 *    payload with a test secret and `constructEvent` verifies it — which is
 *    the only way "a bad signature returns 400" tests anything at all.
 *  - The DATABASE is real, because every claim being made is about
 *    transactions, an exclusion constraint and a primary-key idempotency guard.
 *    A mocked database would prove none of them.
 *  - Only the Stripe API CALL is faked: `refunds.create`. Nothing else in this
 *    file talks to Stripe over the network.
 */

const WEBHOOK_SECRET = "whsec_openings_suite_secret";
const API_VERSION = "2026-07-29.dahlia" as const;

/** The one Stripe call the webhook makes. Hoisted so `vi.mock` can close over it. */
const stripeApi = vi.hoisted(() => ({
  refundsCreate: vi.fn(),
}));

vi.mock("@/lib/payments/stripe", async () => {
  const { default: StripeCtor } = await import("stripe");

  /* A real client with a fake key. `webhooks.constructEvent` is HMAC over the
     payload and never touches the network, so it works perfectly with a key
     that does not exist; `refunds.create` is the part that would, and it is
     replaced. */
  const real = new StripeCtor("sk_test_openings_suite", {
    apiVersion: API_VERSION,
  });

  return {
    STRIPE_API_VERSION: API_VERSION,
    isStripeConfigured: () => true,
    requireStripe: () => {
      throw new Error("requireStripe is not used by the webhook");
    },
    getStripe: () => ({
      webhooks: real.webhooks,
      refunds: { create: stripeApi.refundsCreate },
    }),
  };
});

let ctx: TestContext;
let db: Db;
let POST: (request: Request) => Promise<Response>;

/** Signs payloads. A separate client from the mocked one, on purpose. */
const signer = new Stripe("sk_test_openings_signer", { apiVersion: API_VERSION });

beforeAll(async () => {
  ctx = await setupTestDatabase();
  db = ctx.db;

  /**
   * The route imports the APPLICATION database singleton, which reads
   * DATABASE_URL at module scope. Point it at the test database and set the
   * signing secret BEFORE the dynamic import below, or the handler would open
   * a pool against the development database and truncate it.
   */
  process.env.DATABASE_URL = requireTestDatabaseUrl();
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

  ({ POST } = await import("@/app/api/webhooks/stripe/route"));

  await db.execute(sql`
    UPDATE businesses
       SET min_lead_time_min = 0, max_advance_days = 400
     WHERE id = ${ctx.businessId}
  `);
});

afterAll(async () => {
  await ctx.pool.end();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE appointments RESTART IDENTITY CASCADE`);
  await db.delete(webhookEvents);
  await db.delete(availabilityRules);
  await db.delete(serviceStaff);

  stripeApi.refundsCreate.mockReset();
  stripeApi.refundsCreate.mockResolvedValue({ id: "re_test", amount: 2500 });

  /* The webhook logs loudly on purpose. Silenced so a passing run is quiet. */
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ===========================================================================
   Fixtures
   =========================================================================== */

/** Ana works Tuesdays and performs the plain service. */
async function openTuesdays() {
  await db.insert(serviceStaff).values({
    serviceId: ctx.plainServiceId,
    staffId: ctx.staffA,
  });

  await db.insert(availabilityRules).values({
    staffId: ctx.staffA,
    /** 2 = Tuesday, matching Postgres `extract(dow)`. 2026-09-15 is one. */
    weekday: 2,
    startLocal: "09:00",
    endLocal: "17:00",
    effectiveFrom: "2026-01-01",
  });
}

/** A hold that has reached a payment page: a customer, and a session id. */
async function holdInCheckout(startsAt = at(10)) {
  const held = await createHold(db, {
    businessId: ctx.businessId,
    staffId: ctx.staffA,
    serviceId: ctx.plainServiceId,
    customerId: ctx.customerId,
    startsAt,
  });

  const sessionId = `cs_test_${randomUUID().replace(/-/g, "")}`;

  await db
    .update(appointments)
    .set({ stripeCheckoutSessionId: sessionId, depositCents: 2500 })
    .where(eq(appointments.id, held.appointment.id));

  return { id: held.appointment.id, sessionId };
}

interface EventOptions {
  eventId?: string;
  appointmentId?: string | null;
  sessionId?: string;
  paymentIntentId?: string;
  /** Drop the ownership tag, the way another application's event would. */
  foreign?: boolean;
}

function checkoutEvent(
  type: "checkout.session.completed" | "checkout.session.expired",
  options: EventOptions = {},
) {
  const appointmentId = options.appointmentId ?? null;

  return {
    id: options.eventId ?? `evt_${randomUUID().replace(/-/g, "")}`,
    object: "event",
    api_version: API_VERSION,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type,
    data: {
      object: {
        id: options.sessionId ?? `cs_test_${randomUUID().replace(/-/g, "")}`,
        object: "checkout.session",
        amount_total: 2500,
        currency: "eur",
        client_reference_id: appointmentId,
        payment_intent: options.paymentIntentId ?? "pi_test_openings",
        status: type === "checkout.session.completed" ? "complete" : "expired",
        metadata: options.foreign
          ? { app: "meridian", booking_id: "whatever" }
          : {
              [CHECKOUT_METADATA.app]: OWNER_TAG,
              [CHECKOUT_METADATA.appointmentId]: appointmentId ?? "",
              [CHECKOUT_METADATA.businessId]: ctx.businessId,
            },
      },
    },
  };
}

function chargeRefundedEvent(options: {
  paymentIntentId: string;
  amountRefunded: number;
  full?: boolean;
}) {
  return {
    id: `evt_${randomUUID().replace(/-/g, "")}`,
    object: "event",
    api_version: API_VERSION,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type: "charge.refunded",
    data: {
      object: {
        id: `ch_test_${randomUUID().replace(/-/g, "")}`,
        object: "charge",
        payment_intent: options.paymentIntentId,
        amount: 2500,
        amount_refunded: options.amountRefunded,
        refunded: options.full ?? true,
        metadata: {
          [CHECKOUT_METADATA.app]: OWNER_TAG,
        },
      },
    },
  };
}

/** POST an event at the real route, signed the way Stripe signs one. */
async function deliver(event: object, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);

  const signature = signer.webhooks.generateTestHeaderString({
    payload,
    secret,
  });

  return POST(
    new Request("http://localhost:3000/api/webhooks/stripe", {
      method: "POST",
      headers: {
        "stripe-signature": signature,
        "content-type": "application/json",
      },
      body: payload,
    }),
  );
}

const rowsFor = (appointmentId: string) =>
  db
    .select()
    .from(notifications)
    .where(eq(notifications.appointmentId, appointmentId));

const appointmentById = async (id: string) => {
  const [row] = await db
    .select()
    .from(appointments)
    .where(eq(appointments.id, id))
    .limit(1);

  return row ?? null;
};

/* ===========================================================================
   Signature
   =========================================================================== */

describe("signature verification", () => {
  it("refuses a payload signed with the wrong secret", async () => {
    const response = await deliver(
      checkoutEvent("checkout.session.completed"),
      "whsec_not_the_secret",
    );

    expect(response.status).toBe(400);
  });

  it("refuses a request with no signature header at all", async () => {
    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        body: JSON.stringify(checkoutEvent("checkout.session.completed")),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("refuses a body that was altered after signing", async () => {
    /* The reason the route reads the RAW body: the signature is an HMAC over
       exact bytes, so a single changed character has to fail. */
    const event = checkoutEvent("checkout.session.completed");
    const payload = JSON.stringify(event);

    const signature = signer.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });

    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": signature },
        body: payload.replace('"amount_total":2500', '"amount_total":1'),
      }),
    );

    expect(response.status).toBe(400);
  });
});

/* ===========================================================================
   Ownership — the shared Stripe account
   =========================================================================== */

describe("events from another application on the same Stripe account", () => {
  it("acknowledges them without touching anything", async () => {
    /* A test-mode account belongs to a developer, not a project, and its
       webhook secret signs every event on it. A valid signature therefore says
       nothing about whose event this is — the `app` tag does. */
    const hold = await holdInCheckout();

    const response = await deliver(
      checkoutEvent("checkout.session.completed", {
        appointmentId: hold.id,
        foreign: true,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ignored" });

    const after = await appointmentById(hold.id);
    expect(after?.status).toBe("held");

    /* And it is not recorded: webhook_events is this application's record of
       what IT processed. */
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });

  it("ignores event types it does not act on", async () => {
    const response = await deliver({
      id: `evt_${randomUUID().replace(/-/g, "")}`,
      object: "event",
      api_version: API_VERSION,
      created: Math.floor(Date.now() / 1000),
      type: "payment_intent.created",
      data: { object: { id: "pi_test_x", object: "payment_intent" } },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ignored" });
  });
});

/* ===========================================================================
   checkout.session.completed
   =========================================================================== */

describe("checkout.session.completed", () => {
  it("confirms the appointment and queues its messages", async () => {
    const hold = await holdInCheckout();

    const response = await deliver(
      checkoutEvent("checkout.session.completed", {
        appointmentId: hold.id,
        sessionId: hold.sessionId,
        paymentIntentId: "pi_test_confirmed",
      }),
    );

    expect(response.status).toBe(200);

    const booked = await appointmentById(hold.id);
    expect(booked?.status).toBe("confirmed");
    expect(booked?.holdExpiresAt).toBeNull();
    expect(booked?.stripePaymentIntentId).toBe("pi_test_confirmed");
    /* Stable for the appointment's whole life — a reschedule reuses it. */
    expect(booked?.icsUid).toMatch(/@openings$/);
    expect(booked?.manageTokenHash).toHaveLength(64);

    const queued = await rowsFor(hold.id);
    expect(queued.map((row) => row.kind).sort()).toEqual([
      "confirmation",
      "reminder",
    ]);
    /* Written, never sent. A worker delivers them. */
    expect(queued.every((row) => row.status === "pending")).toBe(true);
    expect(queued.every((row) => row.sentAt === null)).toBe(true);
  });

  it("queues no reminder for a booking made inside the reminder window", async () => {
    /* The appointment is sooner than the reminder would be, so a reminder row
       would fire immediately and read as a duplicate confirmation. */
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    const hold = await holdInCheckout(soon);

    await deliver(
      checkoutEvent("checkout.session.completed", { appointmentId: hold.id }),
    );

    const queued = await rowsFor(hold.id);
    expect(queued.map((row) => row.kind)).toEqual(["confirmation"]);
  });

  it("produces ONE confirmed appointment and ONE set of outbox rows when the same event arrives twice", async () => {
    const hold = await holdInCheckout();
    const event = checkoutEvent("checkout.session.completed", {
      appointmentId: hold.id,
      sessionId: hold.sessionId,
    });

    const first = await deliver(event);
    const second = await deliver(event);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ status: "duplicate" });

    const confirmed = await db
      .select()
      .from(appointments)
      .where(eq(appointments.status, "confirmed"));

    expect(confirmed).toHaveLength(1);
    expect(await rowsFor(hold.id)).toHaveLength(2);
    expect(await db.select().from(webhookEvents)).toHaveLength(1);
  });

  it("is still safe when a DIFFERENT event names an appointment already confirmed", async () => {
    /* The primary-key guard covers a redelivery of one event. This covers the
       other shape: a resend that Stripe gives a new id, or an event type we
       start acting on later. The transaction reads `confirmed` and writes
       nothing. */
    const hold = await holdInCheckout();

    await deliver(
      checkoutEvent("checkout.session.completed", { appointmentId: hold.id }),
    );
    await deliver(
      checkoutEvent("checkout.session.completed", { appointmentId: hold.id }),
    );

    expect(await rowsFor(hold.id)).toHaveLength(2);
  });

  it("acknowledges an event naming an appointment that does not exist", async () => {
    /* A poison event. Retrying it for three days will not make the row appear,
       so it is logged loudly and answered 200. */
    const response = await deliver(
      checkoutEvent("checkout.session.completed", {
        appointmentId: randomUUID(),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "unresolved",
    });
  });
});

/* ===========================================================================
   THE HARD CASE
   =========================================================================== */

describe("the payment landed after the slot had gone", () => {
  it("refunds, cancels, and queues an apology with the nearest openings", async () => {
    await openTuesdays();

    const hold = await holdInCheckout();

    /**
     * Make it happen the way it happens in production: the hold lapses while
     * the customer is on Stripe's page, and the janitor reclaims it. Because
     * the row reached a payment page it is CANCELLED rather than deleted —
     * which is the only reason there is anything here to refund against.
     */
    await expireHold(db, hold.id);
    await reclaimExpiredHolds(db);

    const swept = await appointmentById(hold.id);
    expect(swept?.status).toBe("cancelled");
    expect(swept?.cancellationReason).toBe(
      CANCELLATION_REASON.holdLapsedInCheckout,
    );

    const response = await deliver(
      checkoutEvent("checkout.session.completed", {
        appointmentId: hold.id,
        sessionId: hold.sessionId,
        paymentIntentId: "pi_test_too_late",
      }),
    );

    expect(response.status).toBe(200);

    /* 1. The money went back, in full, without anybody being asked. */
    expect(stripeApi.refundsCreate).toHaveBeenCalledTimes(1);
    expect(stripeApi.refundsCreate.mock.calls[0][0]).toMatchObject({
      payment_intent: "pi_test_too_late",
    });

    /* 2. The row says what happened, in words an owner can read. */
    const after = await appointmentById(hold.id);
    expect(after?.status).toBe("cancelled");
    expect(after?.cancellationReason).toBe(
      CANCELLATION_REASON.slotLostAfterPayment,
    );
    expect(after?.refundedCents).toBe(2500);
    expect(after?.refundedAt).toBeInstanceOf(Date);
    expect(after?.stripePaymentIntentId).toBe("pi_test_too_late");

    /* 3. The apology is queued, and it is an offer rather than a dead end. */
    const queued = await rowsFor(hold.id);
    expect(queued.map((row) => row.kind)).toEqual(["slot_lost"]);

    const payload = queued[0].payload as SlotLostPayload;
    expect(payload.kind).toBe("slot_lost");
    expect(payload.refundedCents).toBe(2500);
    expect(payload.currency).toBe("EUR");
    expect(payload.alternatives.length).toBeGreaterThan(0);
    expect(payload.alternatives.length).toBeLessThanOrEqual(3);
    expect(payload.rebookPath).toContain("/book/test-clinic");

    /* And the booking was never confirmed. */
    expect(
      await db.select().from(appointments).where(eq(appointments.status, "confirmed")),
    ).toHaveLength(0);
  });

  it("still cancels and apologises when the refund itself fails", async () => {
    /* Nothing useful can be retried inside a webhook, so the failure is logged
       at the loudest volume available and the rest of the path still runs — a
       human has to finish it, and they need the record to do that. */
    stripeApi.refundsCreate.mockRejectedValue(new Error("Stripe is down"));

    const hold = await holdInCheckout();
    await expireHold(db, hold.id);
    await reclaimExpiredHolds(db);

    const response = await deliver(
      checkoutEvent("checkout.session.completed", {
        appointmentId: hold.id,
        paymentIntentId: "pi_test_refund_failed",
      }),
    );

    expect(response.status).toBe(200);

    const after = await appointmentById(hold.id);
    expect(after?.status).toBe("cancelled");
    expect(after?.refundedAt).toBeNull();

    expect((await rowsFor(hold.id)).map((row) => row.kind)).toEqual([
      "slot_lost",
    ]);
  });

  it("keeps the row for a lapsed hold in checkout, and deletes one that never got there", async () => {
    /* The invariant the whole hard case rests on. A hold that reached a
       payment page becomes a cancellation; an ordinary one is deleted, because
       it never became anything and a cancelled row would only clutter the
       agenda. Neither blocks the slot. */
    const inCheckout = await holdInCheckout(at(10));

    const plain = await createHold(db, {
      businessId: ctx.businessId,
      staffId: ctx.staffB,
      serviceId: ctx.plainServiceId,
      customerId: ctx.customerId,
      startsAt: at(10),
    });

    await expireHold(db, inCheckout.id);
    await expireHold(db, plain.appointment.id);
    await reclaimExpiredHolds(db);

    expect((await appointmentById(inCheckout.id))?.status).toBe("cancelled");
    expect(await appointmentById(plain.appointment.id)).toBeNull();

    /* Cancelled is outside the exclusion constraint's partial index, so the
       time is genuinely back in the day. */
    const rebooked = await createHold(db, {
      businessId: ctx.businessId,
      staffId: ctx.staffA,
      serviceId: ctx.plainServiceId,
      customerId: ctx.customerId,
      startsAt: at(10),
    });

    expect(rebooked.appointment.id).toBeTruthy();
  });
});

/* ===========================================================================
   checkout.session.expired
   =========================================================================== */

describe("checkout.session.expired", () => {
  it("gives the slot back", async () => {
    const hold = await holdInCheckout();

    const response = await deliver(
      checkoutEvent("checkout.session.expired", {
        appointmentId: hold.id,
        sessionId: hold.sessionId,
      }),
    );

    expect(response.status).toBe(200);

    const after = await appointmentById(hold.id);
    expect(after?.status).toBe("cancelled");
    expect(after?.cancellationReason).toBe(
      CANCELLATION_REASON.checkoutAbandoned,
    );

    /* The time is bookable again. */
    const rebooked = await createHold(db, {
      businessId: ctx.businessId,
      staffId: ctx.staffA,
      serviceId: ctx.plainServiceId,
      customerId: ctx.customerId,
      startsAt: at(10),
    });

    expect(rebooked.appointment.id).toBeTruthy();
  });

  it("does not disturb an appointment that was already confirmed", async () => {
    /* Ordinary sequencing, not a race: Stripe expires the session half an hour
       later regardless, and a booking that went through must survive it. */
    const hold = await holdInCheckout();

    await deliver(
      checkoutEvent("checkout.session.completed", { appointmentId: hold.id }),
    );
    await deliver(
      checkoutEvent("checkout.session.expired", { appointmentId: hold.id }),
    );

    expect((await appointmentById(hold.id))?.status).toBe("confirmed");
  });
});

/* ===========================================================================
   charge.refunded
   =========================================================================== */

describe("charge.refunded", () => {
  it("records the money and tells the owner, without cancelling the booking", async () => {
    /* A refund is a decision about money, not about the diary. Cancelling on
       its own initiative would delete a booking the business may still intend
       to honour, so the owner is told and the owner decides. */
    const hold = await holdInCheckout();

    await deliver(
      checkoutEvent("checkout.session.completed", {
        appointmentId: hold.id,
        paymentIntentId: "pi_test_refundable",
      }),
    );

    const response = await deliver(
      chargeRefundedEvent({
        paymentIntentId: "pi_test_refundable",
        amountRefunded: 2500,
      }),
    );

    expect(response.status).toBe(200);

    const after = await appointmentById(hold.id);
    expect(after?.refundedCents).toBe(2500);
    expect(after?.refundedAt).toBeInstanceOf(Date);
    /* Still on the books. */
    expect(after?.status).toBe("confirmed");

    const queued = await rowsFor(hold.id);
    const alert = queued.find((row) => row.kind === "refund");

    expect(alert).toBeDefined();
    /* To the BUSINESS. Stripe already emails the customer a receipt. */
    expect(alert?.toEmail).toBe("hello@example.test");
  });

  it("does not alarm the owner about a refund this application made itself", async () => {
    /* The slot-lost path already refunded and already logged loudly. A second
       alert would be telling the owner off for something the product did on
       purpose. */
    const hold = await holdInCheckout();
    await expireHold(db, hold.id);
    await reclaimExpiredHolds(db);

    await deliver(
      checkoutEvent("checkout.session.completed", {
        appointmentId: hold.id,
        paymentIntentId: "pi_test_self_refund",
      }),
    );

    await deliver(
      chargeRefundedEvent({
        paymentIntentId: "pi_test_self_refund",
        amountRefunded: 2500,
      }),
    );

    const kinds = (await rowsFor(hold.id)).map((row) => row.kind);
    expect(kinds).toEqual(["slot_lost"]);
  });

  it("ignores a refund on a payment this application never took", async () => {
    /* The shared-account case again, and the overwhelmingly likely one. */
    const response = await deliver(
      chargeRefundedEvent({
        paymentIntentId: "pi_belongs_to_another_app",
        amountRefunded: 500,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "unresolved",
    });
  });
});
