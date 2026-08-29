import { e2eDb, seedE2eBusiness } from "./fixtures/database";

/**
 * Build the fixture business once, before the browser starts.
 *
 * Migrations run here too. In CI the database is an empty container a few
 * seconds old, so something has to apply them, and doing it once in setup is
 * cheaper and less racy than having each spec check.
 */
export default async function globalSetup(): Promise<void> {
  const { db, pool } = e2eDb();

  try {
    await seedE2eBusiness(db);
  } finally {
    await pool.end();
  }
}
