import "server-only";

import { z } from "zod";

import { parse } from "./env";

/**
 * Typed, validated configuration — THE SERVER HALF, AND THE SECRETS.
 *
 * ═══ `server-only` IS THE POINT OF THIS FILE ═══
 *
 * This module holds the schema for every secret the application has. It lived
 * next to the client schema until a scan of the built browser bundle showed
 * what that costs: a Client Component importing `clientEnv` pulls in the whole
 * module, so every server variable name and every literal `.default(...)` in
 * this schema was being shipped to browsers.
 *
 * No secret VALUE ever was — Next replaces non-public `process.env.X` with
 * `undefined` in a client bundle, and the scan confirmed it. But `EMAIL_FROM`'s
 * default sender address was in there, and the next person to write a default
 * has no reason to suspect it becomes public.
 *
 * With `server-only` at the top, importing this from a Client Component is a
 * BUILD FAILURE with a message that says why. The hazard is now impossible to
 * hit by accident rather than merely absent today.
 *
 * PARSED LAZILY, on first property access — see the note in ./env.ts.
 */

const serverSchema = z.object({

  /** Postgres connection string. Neon in deployment. Required — nothing works without it. */
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  /** Better Auth session signing secret. Business owners only; customers book as guests. */
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),

  /** Origin Better Auth issues callbacks against, e.g. http://localhost:3000 */
  BETTER_AUTH_URL: z.url(),

  /** Stripe test-mode secret key. Absent: deposits are disabled and booking is free-of-charge. */
  STRIPE_SECRET_KEY: z.string().min(1).optional(),

  /** Signing secret for the webhook route. Absent: incoming webhooks are rejected. */
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),

  /** Resend API key. Absent: the mailer falls back to logging the message to the console. */
  RESEND_API_KEY: z.string().min(1).optional(),

  /** Envelope sender for transactional mail, e.g. "Openings <bookings@example.com>". */
  EMAIL_FROM: z.string().min(1).default("Openings <onboarding@resend.dev>"),

  /** Upstash QStash publish token. Absent: per-booking reminders are not scheduled and the daily cron is the only safety net. */
  QSTASH_TOKEN: z.string().min(1).optional(),
  QSTASH_CURRENT_SIGNING_KEY: z.string().min(1).optional(),
  QSTASH_NEXT_SIGNING_KEY: z.string().min(1).optional(),

  /** Shared secret the Vercel cron presents on the daily janitor route. */
  CRON_SECRET: z.string().min(1).optional(),

  /** Seed credentials for the demo business owner. Used by the seed script only. */
  DEMO_OWNER_EMAIL: z.email().optional(),
  DEMO_OWNER_PASSWORD: z.string().min(8).optional(),

  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let serverEnvCache: ServerEnv | null = null;

function readServerEnv(): ServerEnv {
  /**
   * Parsed on first READ rather than at module scope.
   *
   * That was originally to survive being pulled into a browser bundle, which
   * `server-only` now prevents outright. It still earns its place on the
   * server: a unit test that imports one pure function from a module sitting
   * next to a configured one should not die because a variable it never reads
   * is unset.
   */
  if (typeof window !== "undefined") {
    /* Belt and braces behind `server-only`: that import fails the build, and
       this fails loudly if some future bundler configuration lets the module
       through anyway. */
    throw new Error(
      "serverEnv was read in the browser. Server configuration never reaches " +
        "the client — use clientEnv, and add a NEXT_PUBLIC_ value if the " +
        "browser genuinely needs to know.",
    );
  }

  return (serverEnvCache ??= parse(
    serverSchema,
    process.env as Record<string, string | undefined>,
    "server",
  ));
}

/**
 * Server-side configuration. Never import this from a client component.
 *
 * Reads like a plain object and is parsed once, on the first property access.
 * In practice that is still startup: `src/db/index.ts` reads DATABASE_URL
 * while it is being evaluated, so a misconfigured deploy dies with the full
 * list of what is missing before it serves a request.
 */
export const serverEnv: ServerEnv = new Proxy({} as ServerEnv, {
  get: (_target, property) =>
    readServerEnv()[property as keyof ServerEnv],
  has: (_target, property) => property in readServerEnv(),
  ownKeys: () => Reflect.ownKeys(readServerEnv()),
  getOwnPropertyDescriptor: (_target, property) =>
    Object.getOwnPropertyDescriptor(readServerEnv(), property),
});
