import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDb, type Db } from "../../src/db/client";
import {
  appointments,
  availabilityRules,
  businesses,
  services,
  serviceStaff,
  staff,
  users,
} from "../../src/db/schema";

/**
 * The world the browser tests book into.
 *
 * ═══ ITS OWN BUSINESS, AND ITS OWN DATABASE ═══
 *
 * The E2E does not use the demo seed. The demo is scenery for a person to look
 * at — it drifts as days pass, it fills up as visitors book into it, and a
 * suite that depended on it would fail on a Tuesday for reasons nobody could
 * reproduce. This fixture is the opposite: open every day from 08:00 to 20:00,
 * no lead time, nothing booked, so a free slot exists whenever the suite runs.
 *
 * `E2E_DATABASE_URL` (falling back to `TEST_DATABASE_URL`) keeps it off a
 * development database, because the setup DELETES its business by slug before
 * rebuilding it. In CI both are the same throwaway container.
 */

/** The slug the specs navigate to. Stable, so a failure is reproducible. */
export const E2E_SLUG = "e2e-test-studio";

/** The service with nothing to pay. Confirms in the booking transaction. */
export const FREE_SERVICE = "Quick consult";

/** The service with a deposit. Goes to Stripe when a key is configured. */
export const DEPOSIT_SERVICE = "Full session";

export function e2eDatabaseUrl(): string {
  for (const file of [".env.local", ".env.test.local", ".env"]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // optional
    }
  }

  const url =
    process.env.E2E_DATABASE_URL?.trim() ||
    process.env.TEST_DATABASE_URL?.trim();

  if (!url) {
    throw new Error(
      "E2E_DATABASE_URL (or TEST_DATABASE_URL) is not set.\n\n" +
        "The browser tests seed and delete their own business, so they refuse\n" +
        "to run against DATABASE_URL. Point one of them at a scratch database\n" +
        "or a Neon branch.",
    );
  }

  return url;
}

export function e2eDb(): { db: Db; pool: { end(): Promise<void> } } {
  return createDb(e2eDatabaseUrl(), 5);
}

/**
 * Build the fixture, replacing whatever was there.
 *
 * Deleting the business cascades to its staff, services, rules and
 * appointments, so one statement leaves nothing behind. Reconciling it row by
 * row would be a migration engine written for scenery.
 */
export async function seedE2eBusiness(db: Db): Promise<{
  businessId: string;
  freeServiceId: string;
  depositServiceId: string;
}> {
  await migrate(db, { migrationsFolder: "./drizzle" });

  await db.delete(businesses).where(eq(businesses.slug, E2E_SLUG));

  const ownerId = `e2e-owner-${E2E_SLUG}`;

  await db
    .insert(users)
    .values({
      id: ownerId,
      name: "E2E Owner",
      email: `${ownerId}@example.test`,
      emailVerified: true,
    })
    .onConflictDoNothing();

  const [business] = await db
    .insert(businesses)
    .values({
      name: "E2E Test Studio",
      slug: E2E_SLUG,
      description: "A fixture. Nothing here is a real business.",
      address: "1 Test Street\nTestville\nTestland",
      /* A zone with daylight saving, so the fixture is not accidentally
         correct only because it never changes offset. */
      timezone: "Europe/Berlin",
      currency: "EUR",
      ownerUserId: ownerId,
      contactEmail: "hello@e2e.test",
      slotGranularityMin: 30,
      /**
       * NO LEAD TIME, and it is the one policy this fixture relaxes.
       *
       * The default two hours is correct for a real business and hostile to a
       * test: a suite running at 19:30 against a shop that shuts at 20:00
       * would find today empty and pass or fail depending on the clock. Lead
       * time itself is tested where it belongs, against injected clocks, in
       * test/2-time and test/5-policy.
       */
      minLeadTimeMin: 0,
      maxAdvanceDays: 60,
      cancellationWindowHours: 24,
    })
    .returning();

  const [member] = await db
    .insert(staff)
    .values({
      businessId: business.id,
      name: "Robin Fixture",
      initials: "RF",
    })
    .returning();

  const inserted = await db
    .insert(services)
    .values([
      {
        businessId: business.id,
        name: FREE_SERVICE,
        description: "Thirty minutes, nothing to pay up front.",
        durationMin: 30,
        bufferBeforeMin: 0,
        bufferAfterMin: 0,
        priceCents: 4_000,
        depositType: "none",
        depositValue: 0,
        displayOrder: 0,
      },
      {
        businessId: business.id,
        name: DEPOSIT_SERVICE,
        description: "An hour, with a deposit taken at booking.",
        durationMin: 60,
        bufferBeforeMin: 0,
        bufferAfterMin: 0,
        priceCents: 10_000,
        depositType: "percent",
        depositValue: 20,
        displayOrder: 1,
      },
    ])
    .returning();

  await db.insert(serviceStaff).values(
    inserted.map((service) => ({
      serviceId: service.id,
      staffId: member.id,
    })),
  );

  /**
   * Open every day of the week, 08:00 to 20:00, from well in the past.
   *
   * Every day so no run lands on a closed weekend; from the past so the rule
   * governs today rather than starting this morning.
   */
  await db.insert(availabilityRules).values(
    Array.from({ length: 7 }, (_, weekday) => ({
      staffId: member.id,
      weekday,
      startLocal: "08:00:00",
      endLocal: "20:00:00",
      effectiveFrom: "2020-01-01",
    })),
  );

  return {
    businessId: business.id,
    freeServiceId: inserted[0].id,
    depositServiceId: inserted[1].id,
  };
}

/** Clear the diary between specs, so one run's booking cannot block the next. */
export async function clearE2eAppointments(db: Db): Promise<void> {
  await db.execute(sql`
    DELETE FROM appointments
     USING businesses
     WHERE businesses.id = appointments.business_id
       AND businesses.slug = ${E2E_SLUG}
  `);
}

export interface BookedRow {
  id: string;
  status: string;
  startsAt: Date;
  icsUid: string;
}

/** Every appointment in the fixture business, newest first. */
export async function e2eAppointments(db: Db): Promise<BookedRow[]> {
  const rows = await db
    .select({
      id: appointments.id,
      status: appointments.status,
      startsAt: appointments.startsAt,
      icsUid: appointments.icsUid,
    })
    .from(appointments)
    .innerJoin(businesses, eq(businesses.id, appointments.businessId))
    .where(eq(businesses.slug, E2E_SLUG));

  return rows.map((row) => ({ ...row, status: String(row.status) }));
}

/** A throwaway address, so two runs never collide on the customer unique index. */
export function uniqueEmail(): string {
  return `e2e-${randomUUID().slice(0, 8)}@example.test`;
}
