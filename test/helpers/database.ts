import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";

import { createDb, type Db } from "@/db/client";
import {
  businesses,
  customers,
  services,
  staff,
  users,
} from "@/db/schema";

/**
 * Test database wiring.
 *
 * These tests TRUNCATE tables between cases, so they refuse to run against
 * anything but an explicitly nominated test database. Pointing them at a
 * development database would quietly destroy its data, so `TEST_DATABASE_URL`
 * is required and must differ from `DATABASE_URL`.
 *
 * With Neon, the cheapest way to get one is a branch — it is a separate
 * connection string against a copy-on-write copy of the database.
 */
export function requireTestDatabaseUrl(): string {
  for (const file of [".env.local", ".env.test.local", ".env"]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // optional
    }
  }

  const url = process.env.TEST_DATABASE_URL;

  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set.\n\n" +
        "The concurrency suite runs against a real Postgres and truncates\n" +
        "tables between tests, so it will not touch DATABASE_URL. Point\n" +
        "TEST_DATABASE_URL at a scratch database or a Neon branch.",
    );
  }

  if (url === process.env.DATABASE_URL) {
    throw new Error(
      "TEST_DATABASE_URL must not be the same database as DATABASE_URL — " +
        "these tests truncate tables.",
    );
  }

  return url;
}

export interface TestContext {
  db: Db;
  pool: Pool;
  businessId: string;
  ownerId: string;
  /** Two staff members, so per-staff isolation can be tested. */
  staffA: string;
  staffB: string;
  /** 60 minutes, no buffers. */
  plainServiceId: string;
  /** 60 minutes, 15 before and 15 after. */
  bufferedServiceId: string;
  customerId: string;
}

/** Connect, apply every migration, and install a fixed set of fixtures. */
export async function setupTestDatabase(): Promise<TestContext> {
  const { db, pool } = createDb(requireTestDatabaseUrl(), 10);

  await migrate(db, { migrationsFolder: "./drizzle" });

  // Fixtures are rebuilt from scratch so a previous aborted run cannot leak in.
  await db.execute(sql`
    TRUNCATE TABLE
      ${businesses}, ${users}
    RESTART IDENTITY CASCADE
  `);

  const ownerId = "test-owner-1";

  await db.insert(users).values({
    id: ownerId,
    name: "Test Owner",
    email: "owner@example.test",
    emailVerified: true,
  });

  const [business] = await db
    .insert(businesses)
    .values({
      name: "Test Clinic",
      slug: "test-clinic",
      timezone: "Europe/Berlin",
      currency: "EUR",
      ownerUserId: ownerId,
      contactEmail: "hello@example.test",
    })
    .returning();

  const insertedStaff = await db
    .insert(staff)
    .values([
      {
        businessId: business.id,
        name: "Ana Ruiz",
        initials: "AR",
        displayOrder: 0,
      },
      {
        businessId: business.id,
        name: "Bo Chen",
        initials: "BC",
        displayOrder: 1,
      },
    ])
    .returning();

  const insertedServices = await db
    .insert(services)
    .values([
      {
        businessId: business.id,
        name: "Consultation",
        durationMin: 60,
        bufferBeforeMin: 0,
        bufferAfterMin: 0,
        priceCents: 9000,
      },
      {
        businessId: business.id,
        name: "Treatment",
        durationMin: 60,
        bufferBeforeMin: 15,
        bufferAfterMin: 15,
        priceCents: 15000,
      },
    ])
    .returning();

  const [customer] = await db
    .insert(customers)
    .values({
      businessId: business.id,
      name: "Sam Taylor",
      email: "sam@example.test",
    })
    .returning();

  return {
    db,
    pool,
    businessId: business.id,
    ownerId,
    staffA: insertedStaff[0].id,
    staffB: insertedStaff[1].id,
    plainServiceId: insertedServices[0].id,
    bufferedServiceId: insertedServices[1].id,
    customerId: customer.id,
  };
}

/** Clear appointments between tests, keeping the fixtures. */
export async function clearAppointments(db: Db): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE appointments RESTART IDENTITY CASCADE`);
}

/** A fixed, DST-free reference day so times in tests read literally. */
export function at(hour: number, minute = 0): Date {
  return new Date(
    Date.UTC(2026, 8 /* September */, 15, hour, minute, 0, 0),
  );
}

/**
 * Force a hold's deadline into the past, the way the clock would.
 *
 * Nothing in the application ever does this — it exists so a test can produce
 * a genuinely expired hold without waiting eight minutes.
 */
export async function expireHold(db: Db, appointmentId: string): Promise<void> {
  await db.execute(sql`
    UPDATE appointments
       SET hold_expires_at = now() - interval '1 minute'
     WHERE id = ${appointmentId}
  `);
}
