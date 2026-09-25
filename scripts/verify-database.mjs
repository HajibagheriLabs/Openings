import { readFileSync } from "node:fs";

import pg from "pg";

/**
 * Proves the database this points at can actually prevent a double booking.
 *
 *   npm run db:verify
 *
 * ═══ WHY A SCRIPT, AND WHY IT FAILS LOUDLY ═══
 *
 * The one guarantee this product is built around — two customers cannot hold
 * the same staff member's time — is not in the application. It is the
 * `appointments_no_overlap` exclusion constraint, which needs `btree_gist`.
 * If either is missing the application still starts, still renders, still
 * takes bookings, and simply stops being correct under concurrency. Nothing
 * on screen would ever say so.
 *
 * So after migrating a new environment, this is run against it, and it exits
 * non-zero with a sentence naming what is wrong. It reads the catalogue rather
 * than trusting the migration table: a migration recorded as applied is a
 * claim, `pg_constraint` is the fact.
 *
 * It uses DATABASE_URL, from the environment or from .env.local — so pointing
 * it at production is `DATABASE_URL=<production url> npm run db:verify`.
 */

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Not present. An explicit DATABASE_URL in the environment wins anyway.
  }
}

const url = process.env.DATABASE_URL?.trim();

if (!url) {
  fail("DATABASE_URL is not set. Point it at the database to check.");
}

/* What migration 0002 creates, as Postgres prints it back. Matched loosely on
   whitespace, strictly on meaning: the operator class, both columns with their
   operators, and the predicate that makes holds and confirmations block. */
const EXPECTED = [
  { what: "a GiST index", pattern: /EXCLUDE USING gist/i },
  { what: "equality on staff_id", pattern: /staff_id WITH =/ },
  { what: "overlap on slot", pattern: /slot WITH &&/ },
  { what: "the held/confirmed predicate", pattern: /'held'.*'confirmed'/ },
];

const client = new pg.Client({
  connectionString: url,
  /* Neon scales to zero, and waking a compute takes several seconds. */
  connectionTimeoutMillis: 30_000,
});

const failures = [];

try {
  await client.connect();

  const { rows: target } = await client.query(
    "SELECT current_database() AS db",
  );

  console.log(`\n  Checking database "${target[0].db}"\n`);

  /* 1. The extension. */
  const { rows: extension } = await client.query(
    "SELECT extversion FROM pg_extension WHERE extname = 'btree_gist'",
  );

  if (extension.length === 0) {
    failures.push(
      "btree_gist is NOT installed. Run `npm run db:migrate` — migration 0000 " +
        "creates it. If that fails, the role lacks permission to create " +
        "extensions; on Neon it has it, elsewhere ask for it.",
    );
  } else {
    pass(`btree_gist ${extension[0].extversion} is installed`);
  }

  /* 2. The constraint, its type, its validity and its definition. */
  const { rows: constraint } = await client.query(`
    SELECT c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE c.conname = 'appointments_no_overlap'
       AND t.relname = 'appointments'
  `);

  if (constraint.length === 0) {
    failures.push(
      "The appointments_no_overlap constraint does NOT exist. This database " +
        "can double-book. Run `npm run db:migrate` (migration 0002).",
    );
  } else {
    const [row] = constraint;

    if (row.contype !== "x") {
      failures.push(
        `appointments_no_overlap exists but is not an exclusion constraint ` +
          `(contype '${row.contype}').`,
      );
    }

    if (!row.convalidated) {
      failures.push(
        "appointments_no_overlap exists but is NOT VALIDATED, so rows written " +
          "before it was added were never checked.",
      );
    }

    for (const { what, pattern } of EXPECTED) {
      if (!pattern.test(row.definition)) {
        failures.push(
          `appointments_no_overlap is missing ${what}. Found:\n      ${row.definition}`,
        );
      }
    }

    if (failures.length === 0) {
      pass(`appointments_no_overlap: ${row.definition}`);
    }
  }

  /* 3. Every migration in the repository has been applied. */
  const journal = JSON.parse(
    readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
  );
  const expected = journal.entries.length;

  const { rows: applied } = await client
    .query("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations")
    .catch(() => ({ rows: [{ n: 0 }] }));

  if (applied[0].n < expected) {
    failures.push(
      `${applied[0].n} of ${expected} migrations are applied. Run \`npm run db:migrate\`.`,
    );
  } else {
    pass(`${applied[0].n} of ${expected} migrations applied`);
  }
} catch (error) {
  failures.push(
    `Could not check the database: ${error instanceof Error ? error.message : String(error)}`,
  );
} finally {
  await client.end().catch(() => {});
}

if (failures.length > 0) {
  console.error("\n  ✗ THIS DATABASE CANNOT BE TRUSTED TO PREVENT DOUBLE BOOKING\n");

  for (const failure of failures) {
    console.error(`    - ${failure}`);
  }

  console.error("");
  process.exit(1);
}

console.log("\n  The database will refuse an overlapping booking.\n");

function pass(message) {
  console.log(`  ✓ ${message}`);
}

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}
