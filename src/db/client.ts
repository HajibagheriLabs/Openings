import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

/**
 * Connection factory.
 *
 * This file deliberately does NOT import src/env.ts. Tests build their own
 * connection against a throwaway database, and importing the env module would
 * force them to satisfy the whole application configuration to open a socket.
 * The application singleton lives in src/db/index.ts instead.
 *
 * node-postgres rather than the Neon serverless driver: the booking path needs
 * real transactions over a real connection, and every concurrency guarantee in
 * this project depends on two sessions being genuinely independent. Neon speaks
 * the standard protocol, so this works against Neon and against local Postgres
 * unchanged.
 */
export function createDb(connectionString: string, poolSize = 10) {
  const pool = new Pool({
    connectionString,
    max: poolSize,
    // Neon terminates idle connections; fail fast rather than hanging a request.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });

  const db = drizzle(pool, { schema, casing: "snake_case" });

  return { db, pool };
}

/** The Drizzle handle, typed with the full schema so relational queries work. */
export type Db = NodePgDatabase<typeof schema>;

/**
 * A handle that may be either the pool-backed database or an open transaction.
 * Functions that must participate in a caller's transaction take this; the
 * booking entry points take `Db`, because they open their own.
 */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export { schema };
