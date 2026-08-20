import { z } from "zod";

/**
 * Typed, validated configuration.
 *
 * Configuration is validated against a schema and throws with the full list of
 * what is wrong, so a misconfigured deploy dies with a readable message
 * instead of handing `undefined` to the Stripe client three requests later.
 *
 * Two schemas, because the boundary matters:
 *  - `serverEnv` holds secrets, is parsed lazily on first read, and refuses to
 *    be read in the browser at all. See the note on `readServerEnv`.
 *  - `clientEnv` holds only `NEXT_PUBLIC_*` values. Those are read through
 *    literal `process.env.NEXT_PUBLIC_...` expressions below because Next
 *    inlines them at build time by textual substitution — dynamic lookup
 *    would produce `undefined` in the browser.
 *
 * Optional values are optional on purpose: the app is meant to run on a laptop
 * with nothing but a database. What each one degrades to is noted inline.
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

const clientSchema = z.object({
  /** Public origin used to build links in emails and Stripe redirect URLs. */
  NEXT_PUBLIC_APP_URL: z.url(),

  /** Stripe publishable key. Absent: the checkout button is hidden. */
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().min(1).optional(),
});

/**
 * An empty variable means "not set".
 *
 * .env.example ships every optional value as `KEY=""`, which is how a dotenv
 * file says "left blank on purpose". Without this, `""` reaches the schema as
 * a present-but-too-short string and a deliberately blank Stripe key fails the
 * build — so following the documented setup would produce an app that refuses
 * to start. Blank-is-absent is also what makes a `.default()` apply.
 */
function withoutBlanks(
  source: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([, value]) => value === undefined || value.trim() !== "",
    ),
  );
}

function parse<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined>,
  label: string,
): z.infer<T> {
  const result = schema.safeParse(withoutBlanks(source));

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    throw new Error(
      `Invalid ${label} environment configuration:\n${details}\n\n` +
        `Copy .env.example to .env.local and fill in the missing values.`,
    );
  }

  return result.data;
}

export type ServerEnv = z.infer<typeof serverSchema>;
export type ClientEnv = z.infer<typeof clientSchema>;

let serverEnvCache: ServerEnv | null = null;

function readServerEnv(): ServerEnv {
  /**
   * A Client Component that imports `clientEnv` pulls this whole module into
   * the browser bundle. Nothing here leaks — the bundler replaces every
   * non-public `process.env.X` with undefined — but if the server schema were
   * parsed at module scope it would throw "DATABASE_URL is required" in the
   * browser and take the page down. So the parse is deferred to first read,
   * and reading it client-side is a loud error rather than a mystery.
   */
  if (typeof window !== "undefined") {
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

/** Browser-safe configuration. Read literally so Next can inline the values. */
export const clientEnv = parse(
  clientSchema,
  {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
  },
  "client",
);

