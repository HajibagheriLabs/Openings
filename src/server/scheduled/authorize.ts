import "server-only";

import { timingSafeEqual } from "node:crypto";

import { Receiver } from "@upstash/qstash";

import { clientEnv, serverEnv } from "@/env";

/**
 * Who is allowed to make this application do scheduled work.
 *
 * Exactly two callers, and nothing else:
 *
 *   THE CRON, which presents `Authorization: Bearer <CRON_SECRET>` — the header
 *   a Vercel cron sends, so nothing has to be configured twice.
 *
 *   THE DELIVERY SERVICE, which signs the request body with a QStash signing
 *   key. A shared secret would be wrong here: QStash's callback is a public
 *   URL and the signature proves both that the request came from QStash AND
 *   that the body is the one we published, which a bearer token cannot.
 *
 * Both routes behind this send email and mutate the database. An unauthorized
 * caller could drain the outbox on demand, so the default answer is no.
 */

export type ScheduledCaller =
  | { allowed: true; via: "cron" | "scheduler" | "development" }
  | { allowed: false; status: 401 | 503; reason: string };

/**
 * Constant-time comparison against the configured secret.
 *
 * `===` would leak, through timing, how many leading characters a guess got
 * right. Lengths are compared first because `timingSafeEqual` throws on a
 * mismatch — and a length is not the secret.
 */
function matchesSecret(presented: string, secret: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(secret, "utf8");

  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerOf(request: Request): string {
  const header = request.headers.get("authorization") ?? "";

  return header.startsWith("Bearer ") ? header.slice(7) : header;
}

/** One receiver per process; it holds parsed keys. */
const globalForReceiver = globalThis as unknown as {
  __openingsReceiver?: Receiver | null;
};

function getReceiver(): Receiver | null {
  if (globalForReceiver.__openingsReceiver !== undefined) {
    return globalForReceiver.__openingsReceiver;
  }

  const currentSigningKey = serverEnv.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = serverEnv.QSTASH_NEXT_SIGNING_KEY;

  globalForReceiver.__openingsReceiver =
    currentSigningKey && nextSigningKey
      ? new Receiver({ currentSigningKey, nextSigningKey })
      : null;

  return globalForReceiver.__openingsReceiver;
}

/**
 * Is this request from the delivery service?
 *
 * THE RAW BODY, UNPARSED, is what gets verified — the signature is computed
 * over exact bytes, and `await request.json()` would parse and re-serialise
 * them into something no longer byte-identical. Read the text, verify the
 * text, and only then look inside it. Same rule as the Stripe webhook.
 *
 * The URL checked against is the CONFIGURED one rather than `request.url`.
 * QStash signed the address we published to it; behind a proxy the incoming
 * URL can differ in scheme or host, and comparing against that would reject
 * perfectly good deliveries for a reason that looks like a bad key.
 */
export async function isSignedByScheduler(
  request: Request,
  body: string,
  path: string,
): Promise<boolean> {
  const receiver = getReceiver();
  const signature = request.headers.get("upstash-signature");

  if (!receiver || !signature) {
    return false;
  }

  try {
    return await receiver.verify({
      signature,
      body,
      url: `${clientEnv.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}${path}`,
    });
  } catch {
    /* An invalid, expired or forged signature. Never an exception onward — the
       caller turns this into a 401 and the route logs nothing sensitive. */
    return false;
  }
}

/**
 * The cron's credential, or a documented development escape hatch.
 *
 * IN PRODUCTION, NO SECRET MEANS NO SERVICE. An open scheduled-work endpoint is
 * an open "send every queued email now" button, and a deploy that forgot the
 * variable should fail loudly rather than run unprotected.
 *
 * IN DEVELOPMENT it runs and says so. The whole product is meant to work on a
 * laptop with nothing but a database — the console mailer and the cron-only
 * scheduler exist for exactly that — and requiring a secret to watch your own
 * confirmation print to your own terminal would defeat the point.
 */
export function authorizeCron(request: Request): ScheduledCaller {
  const secret = serverEnv.CRON_SECRET;

  if (!secret) {
    if (serverEnv.NODE_ENV === "production") {
      return {
        allowed: false,
        status: 503,
        reason:
          "CRON_SECRET is not set. Refusing: this endpoint sends email and will not run unprotected.",
      };
    }

    return { allowed: true, via: "development" };
  }

  return matchesSecret(bearerOf(request), secret)
    ? { allowed: true, via: "cron" }
    : { allowed: false, status: 401, reason: "unauthorized" };
}
