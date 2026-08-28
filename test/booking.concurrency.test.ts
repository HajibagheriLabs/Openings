import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { appointments } from "@/db/schema";
import {
  createHold,
  confirmPaidHold,
  releaseHold,
  reclaimExpiredHolds,
  SlotTakenError,
} from "@/lib/scheduling/booking";

import {
  at,
  clearAppointments,
  expireHold,
  setupTestDatabase,
  type TestContext,
} from "./helpers/database";

/**
 * The headline tests of this repository.
 *
 * Every case below runs against a real Postgres, because the thing under test
 * is not application logic — it is an exclusion constraint. A mock or an
 * in-memory fake would prove nothing at all: the whole claim is that the
 * DATABASE refuses the second write, and only a database can demonstrate that.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
});

afterAll(async () => {
  await ctx.pool.end();
});

beforeEach(async () => {
  await clearAppointments(ctx.db);
});

const hold = (overrides: Partial<Parameters<typeof createHold>[1]> = {}) =>
  createHold(ctx.db, {
    businessId: ctx.businessId,
    staffId: ctx.staffA,
    serviceId: ctx.plainServiceId,
    customerId: ctx.customerId,
    startsAt: at(10),
    ...overrides,
  });

const countAppointments = async () => {
  const result = await ctx.db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM ${appointments}`,
  );
  return Number(result.rows[0].count);
};

/* ========================================================================= */

describe("the exclusion constraint under genuine concurrency", () => {
  it("lets exactly one of two simultaneous overlapping bookings win", async () => {
    // Both requests are launched without awaiting in between, so the two
    // transactions are genuinely open at the same time.
    const results = await Promise.allSettled([
      hold({ startsAt: at(10) }),
      hold({ startsAt: at(10, 30) }), // overlaps 10:00–11:00
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const error = (rejected[0] as PromiseRejectedResult).reason;
    expect(error).toBeInstanceOf(SlotTakenError);
    expect(error.code).toBe("SLOT_TAKEN");
    // The typed error carries the requested time, not a Postgres string.
    expect(error.requested.staffId).toBe(ctx.staffA);
    expect(error.message).not.toMatch(/23P01|exclusion|constraint/i);

    expect(await countAppointments()).toBe(1);
  });

  it("blocks the second writer until the first commits, then rejects it with 23P01", async () => {
    // The test above proves the outcome. This one proves the MECHANISM: that
    // the second transaction genuinely waits on a lock held by the first,
    // rather than the two happening to run one after the other.
    const first = await ctx.pool.connect();
    const second = await ctx.pool.connect();
    let blocked: Promise<unknown> = Promise.resolve();

    let wasWaitingOnLock = false;

    try {
      // Ask the backend for its own pid. `client.processID` is unusable here:
      // Neon's proxy reports a synthetic value that matches no row in
      // pg_stat_activity, so the only reliable source is the server itself.
      const secondPid = await backendPid(second);

      await first.query("BEGIN");
      await second.query("BEGIN");

      await first.query(insertSql(ctx, at(10), "first"));

      // Fire the conflicting insert but do NOT await it — it will block,
      // because the first transaction has not committed.
      blocked = second.query(insertSql(ctx, at(10, 30), "second"));
      blocked.catch(() => {
        // Asserted below; this only stops an unhandled rejection if the
        // assertions throw first.
      });

      wasWaitingOnLock = await waitUntilBlockedOnLock(ctx, secondPid);

      // Commit BEFORE asserting. Releasing the first transaction is what lets
      // the blocked one resolve, and doing it unconditionally means a failed
      // assertion can never strand a lock and starve the pool for every test
      // that follows.
      await first.query("COMMIT");

      await expect(blocked).rejects.toMatchObject({ code: "23P01" });
    } finally {
      await first.query("ROLLBACK").catch(() => {});
      await second.query("ROLLBACK").catch(() => {});
      first.release();
      second.release();
    }

    // The second writer genuinely waited on a lock held by the first, rather
    // than the two happening to run one after the other.
    expect(wasWaitingOnLock).toBe(true);
    expect(await countAppointments()).toBe(1);
  });
});

describe("boundaries", () => {
  it("allows back-to-back appointments that touch at the boundary", async () => {
    // [10:00, 11:00) and [11:00, 12:00) share the instant 11:00 but do not
    // overlap, because the ranges are upper-exclusive. Both must be insertable
    // or no day could ever be filled.
    const first = await hold({ startsAt: at(10) });
    const second = await hold({ startsAt: at(11) });

    expect(first.appointment.id).not.toBe(second.appointment.id);
    expect(first.range.slot).toBe(
      `["${at(10).toISOString()}","${at(11).toISOString()}")`,
    );
    expect(await countAppointments()).toBe(2);
  });

  it("allows the same time for two different staff members", async () => {
    await hold({ staffId: ctx.staffA, startsAt: at(10) });
    await hold({ staffId: ctx.staffB, startsAt: at(10) });

    // staff_id WITH = means the overlap test is scoped per person.
    expect(await countAppointments()).toBe(2);
  });

  it("rejects an overlap for the same staff member", async () => {
    await hold({ startsAt: at(10) });
    await expect(hold({ startsAt: at(10, 30) })).rejects.toBeInstanceOf(
      SlotTakenError,
    );
  });
});

describe("buffers live in the stored range", () => {
  it("blocks an adjacent booking that would fit without buffers", async () => {
    // 10:00–11:00 with a 15-minute after-buffer blocks [09:45, 11:15).
    const buffered = await hold({
      serviceId: ctx.bufferedServiceId,
      startsAt: at(10),
    });

    expect(buffered.range.slot).toBe(
      `["${at(9, 45).toISOString()}","${at(11, 15).toISOString()}")`,
    );
    // Customer-facing times are untouched by the buffers.
    expect(buffered.appointment.startsAt).toEqual(at(10));
    expect(buffered.appointment.endsAt).toEqual(at(11));

    // 11:00 is free as far as the customer-facing times go, but it lands
    // inside the after-buffer, so the constraint rejects it. No query had to
    // remember the buffer — it is in the range.
    await expect(hold({ startsAt: at(11) })).rejects.toBeInstanceOf(
      SlotTakenError,
    );

    // 11:15, immediately after the buffer, is bookable.
    const after = await hold({ startsAt: at(11, 15) });
    expect(after.appointment.id).toBeTruthy();
  });
});

describe("which rows block", () => {
  it("does not let a cancelled appointment block its old slot", async () => {
    const first = await hold({ startsAt: at(10) });
    await confirmPaidHold(ctx.db, { appointmentId: first.appointment.id });

    await expect(hold({ startsAt: at(10) })).rejects.toBeInstanceOf(
      SlotTakenError,
    );

    await ctx.db.execute(sql`
      UPDATE appointments
         SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'customer'
       WHERE id = ${first.appointment.id}
    `);

    // The partial WHERE drops it out of the constraint's index entirely.
    const rebooked = await hold({ startsAt: at(10) });
    expect(rebooked.appointment.id).toBeTruthy();
    expect(await countAppointments()).toBe(2);
  });

  it("lets an UNEXPIRED hold block a new booking", async () => {
    await hold({ startsAt: at(10) });

    // The hold is a real row with status 'held', which the constraint covers,
    // so the slot is genuinely reserved rather than optimistically flagged.
    await expect(hold({ startsAt: at(10) })).rejects.toBeInstanceOf(
      SlotTakenError,
    );
  });

  it("does not let an EXPIRED hold block a new booking", async () => {
    const stale = await hold({ startsAt: at(10) });
    await expireHold(ctx.db, stale.appointment.id);

    // The expired row is STILL in the constraint's index — the predicate
    // cannot reference now(). What makes this work is the DELETE that
    // createHold runs in the same transaction, immediately before inserting.
    const fresh = await hold({ startsAt: at(10) });

    expect(fresh.appointment.id).not.toBe(stale.appointment.id);
    // The stale row was swept, not merely ignored.
    expect(await countAppointments()).toBe(1);
  });

  it("keeps blocking an expired hold that nothing has swept yet", async () => {
    const stale = await hold({ startsAt: at(10) });
    await expireHold(ctx.db, stale.appointment.id);

    // A non-overlapping booking does not sweep it, proving the sweep is
    // scoped and that expiry really is lazy rather than automatic.
    await hold({ startsAt: at(14) });

    const rows = await ctx.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM appointments WHERE id = ${stale.appointment.id}`,
    );
    expect(Number(rows.rows[0].count)).toBe(1);
  });
});

describe("hold lifecycle", () => {
  it("confirms a hold and clears its deadline", async () => {
    const held = await hold({ startsAt: at(10) });
    expect(held.appointment.status).toBe("held");
    expect(held.appointment.holdExpiresAt).toBeInstanceOf(Date);

    const result = await confirmPaidHold(ctx.db, {
      appointmentId: held.appointment.id,
      paymentIntentId: "pi_test_confirm",
    });

    expect(result.outcome).toBe("confirmed");
    const confirmed = (result as { appointment: typeof held.appointment }).appointment;
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.holdExpiresAt).toBeNull();
    expect(confirmed.stripePaymentIntentId).toBe("pi_test_confirm");
  });

  it("confirms a hold whose deadline has passed but whose row survived", async () => {
    const held = await hold({ startsAt: at(10) });
    await expireHold(ctx.db, held.appointment.id);

    // Nothing released it, so the slot stayed reserved the whole time and the
    // hold is still ours. Confirming is the correct outcome, not an error.
    const result = await confirmPaidHold(ctx.db, {
      appointmentId: held.appointment.id,
    });

    expect(result.outcome).toBe("confirmed");
  });

  it("releases a hold and frees the slot immediately", async () => {
    const held = await hold({ startsAt: at(10) });

    expect(await releaseHold(ctx.db, held.appointment.id)).toBe(true);
    expect(await releaseHold(ctx.db, held.appointment.id)).toBe(false);

    const rebooked = await hold({ startsAt: at(10) });
    expect(rebooked.appointment.id).toBeTruthy();
  });

  it("reclaims expired holds without being required for correctness", async () => {
    const stale = await hold({ startsAt: at(10) });
    const live = await hold({ startsAt: at(14) });
    await expireHold(ctx.db, stale.appointment.id);

    const reclaimed = await reclaimExpiredHolds(ctx.db);

    expect(reclaimed).toBe(1);
    expect(await countAppointments()).toBe(1);

    // The unexpired hold is untouched.
    const remaining = await ctx.db.execute<{ id: string }>(
      sql`SELECT id::text AS id FROM appointments`,
    );
    expect(remaining.rows[0].id).toBe(live.appointment.id);
  });
});

/* ========================================================================= */

/** Raw insert used by the interleaving test, mirroring what createHold writes. */
function insertSql(context: TestContext, startsAt: Date, tag: string) {
  const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
  return {
    text: `
      INSERT INTO appointments
        (business_id, staff_id, service_id, customer_id, slot, starts_at,
         ends_at, status, hold_expires_at, price_cents, deposit_cents,
         ics_uid, manage_token_hash)
      VALUES
        ($1, $2, $3, $4, tstzrange($5, $6, '[)'), $5, $6,
         'held', now() + interval '8 minutes', 9000, 0, $7, $8)
    `,
    values: [
      context.businessId,
      context.staffA,
      context.plainServiceId,
      context.customerId,
      startsAt.toISOString(),
      endsAt.toISOString(),
      `${tag}-${Date.now()}@openings`,
      `hash-${tag}`,
    ],
  };
}

/**
 * The backend pid for a connection, straight from the server.
 *
 * `client.processID` comes from the startup handshake, and Neon's proxy fills
 * it with a synthetic value that matches nothing in pg_stat_activity. Asking
 * the backend directly is the only portable way to identify the session.
 */
async function backendPid(client: PoolClient): Promise<number> {
  const result = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  return result.rows[0].pid;
}

/**
 * Poll pg_stat_activity until the given backend is waiting on a lock.
 *
 * This is what turns "these ran at the same time" from an assumption into an
 * assertion: if the second INSERT were not blocked by the first transaction,
 * this would time out and the test would fail. The wait shows up as
 * wait_event_type 'Lock' on wait_event 'transactionid' — the second session
 * waiting for the first transaction to end so it can find out whether the
 * conflicting row became visible.
 */
async function waitUntilBlockedOnLock(
  context: TestContext,
  pid: number,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await context.db.execute<{ waiting: boolean }>(sql`
      SELECT (wait_event_type = 'Lock') AS waiting
        FROM pg_stat_activity
       WHERE pid = ${pid}
    `);

    if (result.rows[0]?.waiting) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return false;
}
