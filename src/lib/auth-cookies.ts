/**
 * Cookie names shared between the Better Auth server instance and the proxy.
 *
 * This module deliberately imports NOTHING. The proxy runs at the edge and
 * must never pull in the database, the env schema, or the auth instance, so
 * the two sides agree on these strings through a leaf module instead of
 * through an import of `@/lib/auth`.
 */

/**
 * Prefix for every cookie Better Auth issues. The session cookie therefore
 * lands as `openings.session_token` (and `__Secure-openings.session_token`
 * once secure cookies are on), which is what `getSessionCookie` looks for in
 * the proxy.
 */
export const AUTH_COOKIE_PREFIX = "openings";

/**
 * A HINT, not a fact.
 *
 * Holds the slug of the business the signed-in owner has already created, so
 * the proxy can send an owner who has not finished onboarding to /onboarding
 * without querying the database at the edge.
 *
 * It is NOT httpOnly-secret material and it is NOT trusted anywhere: it can be
 * forged, stale, or missing, and every server route re-checks ownership
 * against the database regardless of what it says. Its only job is to save a
 * redirect hop.
 *
 * Two writers, and only two:
 *   - the onboarding action, once the business transaction commits;
 *   - GET /api/session/sync, which repairs the cookie when the truth in the
 *     database and the hint disagree. Without that repair route a signed-in
 *     owner whose cookie was cleared would bounce /admin → /onboarding →
 *     /admin forever, because a server component cannot write a cookie.
 */
export const BUSINESS_HINT_COOKIE = "openings.business";

/** One year. The hint is refreshed whenever it turns out to be wrong. */
export const BUSINESS_HINT_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
