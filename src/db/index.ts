import "server-only";

import { serverEnv } from "@/env.server";

import { createDb } from "./client";

/**
 * The application's database handle.
 *
 * One pool per process. In development Next re-evaluates modules on every
 * change, so the pool is stashed on globalThis — otherwise each hot reload
 * would leak a pool and Neon would start refusing connections.
 */
const globalForDb = globalThis as unknown as {
  __openingsDb?: ReturnType<typeof createDb>;
};

const connection = (globalForDb.__openingsDb ??= createDb(
  serverEnv.DATABASE_URL,
));

export const db = connection.db;
export const pool = connection.pool;

export * from "./schema";
