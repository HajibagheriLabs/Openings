import { z } from "zod";

/**
 * Typed, validated configuration.
 *
 * Importing this module parses `process.env` and throws immediately if
 * anything required is missing or malformed, so a misconfigured deploy dies at
 * startup with a readable list instead of handing `undefined` to the Stripe
 * client three requests later.
 *
 * Two schemas, because the boundary matters:
 *  - `serverEnv` holds secrets and must never be imported from a client
 *    component.
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

function parse<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined>,
  label: string,
): z.infer<T> {
  const result = schema.safeParse(source);

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

/** Server-side configuration. Never import this from a client component. */
export const serverEnv = parse(
  serverSchema,
  process.env as Record<string, string | undefined>,
  "server",
);

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

export type ServerEnv = z.infer<typeof serverSchema>;
export type ClientEnv = z.infer<typeof clientSchema>;
