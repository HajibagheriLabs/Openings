import "server-only";

import { createHash } from "node:crypto";

import { lt, sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import { rateLimits } from "@/db/schema";

/**
 * A fixed-window rate limiter, counted in Postgres.
 *
 * ═══ WHY NOT IN MEMORY ═══
 *
 * `/manage/<token>` is a public URL whose only credential is the secret in the
 * path, so the thing worth limiting is somebody walking that path space. On a
 * serverless runtime an in-process counter is per-instance: an attacker
 * spreading requests across cold starts gets a fresh allowance every time, and
 * the limiter measures nothing. One row, one atomic upsert, shared by every
 * instance — and no Redis, which this project does not have and will not pay
 * for.
 *
 * ═══ WHY A FIXED WINDOW AND NOT A SLIDING ONE ═══
 *
 * A sliding window needs the timestamps of individual requests, which means a
 * row per request and a table that grows with traffic. A fixed window keeps
 * exactly ONE row per subject and resets it in place, so the table is bounded
 * by how many distinct subjects are currently active. The cost is the classic
 * boundary artefact: somebody can spend a full allowance at the end of one
 * window and another at the start of the next. For "stop a script guessing at
 * tokens" that is entirely adequate, and it is the honest trade for a table
 * that cannot grow without bound on a free tier.
 *
 * ═══ ONE STATEMENT, NO RACE ═══
 *
 * The upsert below decides, in the database, whether the stored window has
 * rolled and either resets or increments accordingly. Read-then-write would
 * let two concurrent requests both read 4, both write 5, and both be allowed —
 * which is exactly the pattern the rest of this codebase refuses to use for
 * slot booking, and it is no more acceptable here.
 */

export interface RateLimitRule {
  /** How many requests one subject may make in a window. */
  limit: number;
  /** How long the window is, in seconds. */
  windowSeconds: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Requests used in the current window, including this one. */
  used: number;
  limit: number;
  /** Seconds until the current window rolls. For the Retry-After header. */
  retryAfterSeconds: number;
}

/**
 * Hash the subject before it is stored.
 *
 * An IP address is personal data and a manage token is a live credential.
 * Neither belongs in a table in plaintext merely so it can be counted, and a
 * counter does not need to be able to read its own keys. SHA-256 is right here
 * rather than a slow KDF: this is a namespacing and privacy measure over a
 * value we already hold, not a password at rest.
 */
export function rateLimitKey(namespace: string, subject: string): string {
  return `${namespace}:${createHash("sha256").update(subject).digest("hex")}`;
}

/**
 * Count one request against a subject and say whether it is allowed.
 *
 * FAILS OPEN. If the counter itself errors — the database is unreachable, the
 * table is missing on a half-migrated deploy — the request is allowed and the
 * failure is logged. A limiter that takes the whole manage page down when it
 * cannot count has caused more harm than the abuse it was guarding against;
 * every action behind it still has its own authorization and its own idempotency.
 */
export async function consumeRateLimit(
  db: Db,
  key: string,
  rule: RateLimitRule,
): Promise<RateLimitVerdict> {
  try {
    const [row] = await db
      .insert(rateLimits)
      .values({ key, count: 1 })
      .onConflictDoUpdate({
        target: rateLimits.key,
        set: {
          /**
           * Reset or increment, decided in SQL against the database's clock.
           *
           * `excluded.window_started_at` is `now()` from this statement's
           * default, so the comparison is "has the stored window run out as of
           * this request?" — one clock, no round trip, and no window in which
           * two callers can both read the same count.
           */
          count: sql`CASE
            WHEN ${rateLimits.windowStartedAt} < now() - make_interval(secs => ${rule.windowSeconds}::int)
            THEN 1
            ELSE ${rateLimits.count} + 1
          END`,
          windowStartedAt: sql`CASE
            WHEN ${rateLimits.windowStartedAt} < now() - make_interval(secs => ${rule.windowSeconds}::int)
            THEN now()
            ELSE ${rateLimits.windowStartedAt}
          END`,
        },
      })
      .returning({
        count: rateLimits.count,
        windowStartedAt: rateLimits.windowStartedAt,
      });

    const used = row?.count ?? 1;
    const elapsed = row
      ? (Date.now() - row.windowStartedAt.getTime()) / 1000
      : 0;

    return {
      allowed: used <= rule.limit,
      used,
      limit: rule.limit,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil(rule.windowSeconds - Math.max(elapsed, 0)),
      ),
    };
  } catch (error) {
    console.error(
      `[rate-limit] could not count ${key}; allowing the request.`,
      error,
    );

    return {
      allowed: true,
      used: 0,
      limit: rule.limit,
      retryAfterSeconds: 0,
    };
  }
}

/* ===========================================================================
   The manage page's two limits
   =========================================================================== */

/**
 * BY TOKEN, and it is the looser of the two.
 *
 * A real customer reloads their appointment, opens the reschedule picker,
 * flicks through a few days and cancels — perhaps thirty requests in a sitting,
 * and they may well do that twice. This is not there to police a customer; it
 * is there so one leaked link cannot be used to hammer the actions behind it.
 */
export const MANAGE_TOKEN_RULE: RateLimitRule = {
  limit: 60,
  windowSeconds: 5 * 60,
};

/**
 * BY IP, and it is the one that matters.
 *
 * A token is only guessable by trying tokens, and every attempt arrives from
 * somewhere. This bounds how fast one source can walk the token space —
 * 120 attempts per five minutes against a 256-bit HMAC is not a search, it is
 * a rounding error, and legitimate traffic never comes close.
 *
 * Deliberately larger than the token limit: a household, an office or a phone
 * network shares one address, and several customers behind one NAT must not
 * lock each other out.
 */
export const MANAGE_IP_RULE: RateLimitRule = {
  limit: 120,
  windowSeconds: 5 * 60,
};

/**
 * The client's address, as far as it can be known.
 *
 * `x-forwarded-for` is the left-most entry, which is what Vercel's proxy puts
 * there. IT IS SPOOFABLE in general — which is exactly why the IP limit is a
 * blunt outer bound and the token limit sits behind it, and why neither is the
 * thing actually protecting the appointment. Authorization is the token match;
 * these only govern how fast somebody may ask.
 *
 * Absent behind an unusual proxy, and the fallback is a shared bucket rather
 * than no bucket: unattributable traffic should still be counted together.
 */
export function clientAddressOf(request: {
  headers: { get(name: string): string | null };
}): string {
  const forwarded = request.headers.get("x-forwarded-for");

  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();

    if (first) {
      return first;
    }
  }

  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/* ===========================================================================
   Housekeeping
   =========================================================================== */

/**
 * Forget subjects that have gone quiet.
 *
 * Called by the daily sweep. Nothing depends on it: a stale row is reset in
 * place by the next request from that subject, so this only keeps the table
 * from remembering every address that ever visited.
 */
export async function forgetIdleRateLimits(
  db: Db,
  olderThanSeconds = 24 * 60 * 60,
): Promise<number> {
  const deleted = await db
    .delete(rateLimits)
    .where(
      lt(
        rateLimits.windowStartedAt,
        sql`now() - make_interval(secs => ${olderThanSeconds}::int)`,
      ),
    )
    .returning({ key: rateLimits.key });

  return deleted.length;
}
