import { z } from "zod";

/**
 * Typed, validated configuration — THE CLIENT-SAFE HALF.
 *
 * ═══ WHY THIS FILE SPLIT IN TWO ═══
 *
 * It used to hold both schemas. Nothing leaked — Next replaces every
 * non-public `process.env.X` with `undefined` in a browser bundle, and a scan
 * of the built chunks confirmed no secret VALUE was ever in there.
 *
 * What was in there was the server SCHEMA ITSELF. A Client Component that
 * imports `clientEnv` pulls in whatever module it lives in, so every server
 * variable name and, worse, every literal `.default(...)` in that schema was
 * being shipped to browsers. `EMAIL_FROM`'s default sender address was sitting
 * in the bundle for exactly that reason. That one is public and harmless — and
 * it is a loaded gun, because the next person to add a default has no reason
 * to suspect it becomes public.
 *
 * So the server half now lives in `./env.server.ts`, which is marked
 * `server-only`: importing it from a Client Component is a BUILD ERROR rather
 * than a silent disclosure. This file holds the `NEXT_PUBLIC_*` values, which
 * are public by definition, and the parsing helpers both halves share.
 *
 * BOTH are parsed lazily, on first property access. Importing a module is not
 * the same as needing its configuration, and a pure function should not be
 * unreachable from a test because a variable it never reads is unset.
 */

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
 *
 * Exported because `./env.server.ts` parses the same way.
 */
export function withoutBlanks(
  source: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([, value]) => value === undefined || value.trim() !== "",
    ),
  );
}

/** Shared by both halves, so one misconfiguration message covers both. */
export function parse<T extends z.ZodType>(
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

export type ClientEnv = z.infer<typeof clientSchema>;

let clientEnvCache: ClientEnv | null = null;

/**
 * Read LITERALLY, so Next can inline the values.
 *
 * Next replaces the text `process.env.NEXT_PUBLIC_X` with a string constant at
 * build time. That substitution is textual, so it happens whether the
 * expression sits at module scope or inside a function — which means this can
 * be deferred without losing the inlining.
 */
function readClientEnv(): ClientEnv {
  return (clientEnvCache ??= parse(
    clientSchema,
    {
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
      NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:
        process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    },
    "client",
  ));
}

/**
 * Browser-safe configuration.
 *
 * LAZY, for the same reason `serverEnv` is. Importing a module is not the same
 * as needing its configuration: a unit test that pulls in one pure function
 * from a file that happens to sit next to a configured one should not die
 * because NEXT_PUBLIC_APP_URL is unset in the shell. Parsing on first property
 * access keeps the loud, complete error message for anything that genuinely
 * reads a value, and costs nothing for anything that does not.
 */
export const clientEnv: ClientEnv = new Proxy({} as ClientEnv, {
  get: (_target, property) => readClientEnv()[property as keyof ClientEnv],
  has: (_target, property) => property in readClientEnv(),
  ownKeys: () => Reflect.ownKeys(readClientEnv()),
  getOwnPropertyDescriptor: (_target, property) =>
    Object.getOwnPropertyDescriptor(readClientEnv(), property),
});
