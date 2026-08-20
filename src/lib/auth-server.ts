import "server-only";

import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { db } from "@/db";
import { businesses, type Business } from "@/db/schema";
import { auth } from "@/lib/auth";

/**
 * The server-side gate. Every page, layout, Server Action and route handler
 * that touches owner data goes through one of these.
 *
 * The proxy also redirects, but it is a convenience only (see src/proxy.ts).
 * These functions are the boundary that actually decides anything, and they
 * re-check on every request regardless of what the proxy let through.
 */

/** A UUID, as opposed to a slug. Used to decide how to look a business up. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The signed-in owner's session, or null.
 *
 * Wrapped in React's `cache` so a layout, its page and three Server Components
 * that all ask "who is this?" during one render share a single lookup. The
 * cache is per-request and dies with it — it never leaks one owner's session
 * into another's render.
 */
export const getSession = cache(async () => {
  return auth.api.getSession({ headers: await headers() });
});

/**
 * The owner as Better Auth models them. Derived from `getSession` rather than
 * from the Drizzle row type so the two can never drift apart.
 */
export type SessionUser = NonNullable<
  Awaited<ReturnType<typeof getSession>>
>["user"];

/** The signed-in owner, or null. */
export async function getUser(): Promise<SessionUser | null> {
  const session = await getSession();
  return session?.user ?? null;
}

/**
 * Demand a signed-in owner.
 *
 * Redirects to /sign-in rather than throwing, because every caller is a page
 * or an action reached by a person with a browser. `next` carries them back to
 * what they were trying to reach once they are in.
 */
export async function requireUser(nextPath?: string): Promise<SessionUser> {
  const user = await getUser();

  if (!user) {
    const target = nextPath
      ? `/sign-in?next=${encodeURIComponent(nextPath)}`
      : "/sign-in";
    redirect(target);
  }

  return user;
}

/** The business this owner runs, or null if onboarding has not happened yet. */
export const getOwnedBusiness = cache(
  async (ownerUserId: string): Promise<Business | null> => {
    const [business] = await db
      .select()
      .from(businesses)
      .where(eq(businesses.ownerUserId, ownerUserId))
      .limit(1);

    return business ?? null;
  },
);

export interface BusinessAccess {
  user: SessionUser;
  business: Business;
}

/**
 * Load a business by slug or id and assert the caller owns it.
 *
 * 404, NOT 403, when the caller does not own it.
 *
 * A 403 would confirm that a business with that slug exists, which turns this
 * route into a directory of every business on the platform — a competitor
 * could enumerate slugs and learn who is a customer. From the outside, a
 * business you do not own is indistinguishable from one that was never
 * created, and that is the whole point.
 */
export async function requireBusinessAccess(
  slugOrId: string,
): Promise<BusinessAccess> {
  const user = await requireUser();

  const [business] = await db
    .select()
    .from(businesses)
    .where(
      and(
        UUID_PATTERN.test(slugOrId)
          ? eq(businesses.id, slugOrId)
          : eq(businesses.slug, slugOrId),
        // Ownership is part of the lookup rather than a check afterwards, so
        // there is no window in which the row is in hand but unauthorized.
        eq(businesses.ownerUserId, user.id),
      ),
    )
    .limit(1);

  if (!business) {
    notFound();
  }

  return { user, business };
}
