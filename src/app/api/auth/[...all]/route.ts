import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/lib/auth";

/**
 * Every Better Auth endpoint, mounted under /api/auth.
 *
 * Node runtime, not edge: the adapter talks to Postgres over node-postgres and
 * password hashing needs real crypto. Nothing here is customer-facing — these
 * routes serve business owners only.
 */
export const runtime = "nodejs";

export const { GET, POST } = toNextJsHandler(auth.handler);
