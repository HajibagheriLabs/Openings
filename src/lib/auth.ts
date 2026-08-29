import "server-only";

import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";

import { db } from "@/db";
import * as schema from "@/db/schema";
import { clientEnv } from "@/env";
import { serverEnv } from "@/env.server";
import { AUTH_COOKIE_PREFIX } from "@/lib/auth-cookies";
import { APP_NAME } from "@/lib/brand";
import {
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "@/lib/notifications/auth-emails";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@/lib/validation/auth";

/* ===========================================================================
   BUSINESS OWNERS ONLY — read this before adding anything to this file.
   ---------------------------------------------------------------------------
   Every account this instance can create belongs to someone who RUNS a
   business and signs into the admin area. That is the entire authenticated
   population of the product.

   CUSTOMERS NEVER GET AN ACCOUNT. A visitor books as a guest: they are written
   to `customers` (scoped to one business, deduped by email) and they manage
   their appointment through a signed link — `appointments.manage_token_hash`
   — not through a session. There is no customer password, no customer sign-in
   page, and no row in `users` for anyone who has merely booked.

   So: no social providers, no magic links for customers, no "sign in to see
   your bookings". If a future feature seems to need a customer login, it needs
   a better token instead. Making booking require an account is the single
   fastest way to lose the booking.
   =========================================================================== */

/**
 * Secure cookies are decided by the scheme of the deployment origin rather
 * than by NODE_ENV. A Vercel preview build runs with NODE_ENV=production over
 * https and gets them; `next dev` over http does not, because a `Secure`
 * cookie is simply never stored by the browser on a plain-http origin and the
 * whole flow would silently fail to keep anyone signed in.
 */
const useSecureCookies = serverEnv.BETTER_AUTH_URL.startsWith("https://");

export const auth = betterAuth({
  appName: APP_NAME,
  baseURL: serverEnv.BETTER_AUTH_URL,
  secret: serverEnv.BETTER_AUTH_SECRET,

  /**
   * The auth tables live in the same schema file as the booking tables and are
   * migrated by drizzle-kit with everything else, so the adapter is pointed at
   * the existing definitions rather than generating its own.
   *
   * `usePlural` because those tables are exported as `users` / `sessions` /
   * `accounts` / `verifications`; Better Auth's model names are singular and
   * this is what bridges the two. `transaction` so multi-step writes (creating
   * a user and its credential account) either both land or neither does.
   */
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
    usePlural: true,
    transaction: true,
  }),

  emailAndPassword: {
    enabled: true,
    /**
     * Ten, not the default eight. This account can read every customer's name,
     * email and phone number for a business. The same constants back the form,
     * so the rule shown and the rule enforced are one rule.
     */
    minPasswordLength: PASSWORD_MIN_LENGTH,
    maxPasswordLength: PASSWORD_MAX_LENGTH,
    /**
     * An owner cannot sign in until the address is confirmed. The business's
     * contact address is where cancellations, no-shows and payout mail land,
     * so an unverified typo is not a cosmetic problem — it is a business that
     * never hears about a cancelled appointment.
     */
    requireEmailVerification: true,
    /** Nothing to sign into yet; verification is the next step, not a session. */
    autoSignIn: false,
    resetPasswordTokenExpiresIn: 60 * 60,
    /** A reset means "I lost control of this account". Kill the other sessions. */
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      await sendPasswordResetEmail({ to: user.email, name: user.name, url });
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    /** Confirming the address is proof enough; do not ask for the password again. */
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60 * 24,
    sendVerificationEmail: async ({ user, url }) => {
      await sendVerificationEmail({ to: user.email, name: user.name, url });
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    /**
     * No cookie cache on purpose.
     *
     * A cached session would let the proxy read user data at the edge, but it
     * also means a revoked session keeps working until the cache lapses. The
     * database stays the single authority on who is signed in; the proxy makes
     * do with "is there a session cookie at all", which is all a redirect
     * needs.
     */
    cookieCache: { enabled: false },
  },

  advanced: {
    cookiePrefix: AUTH_COOKIE_PREFIX,
    useSecureCookies,
    /**
     * `lax` rather than `strict`: the verification and reset links arrive from
     * an email client, which is a cross-site navigation, and `strict` would
     * drop the session cookie on exactly that hop. `httpOnly` keeps the token
     * out of reach of any script on the page.
     */
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
      secure: useSecureCookies,
      path: "/",
    },
  },

  /**
   * Origins allowed to receive redirects and to send credentialed requests.
   * Both names are listed because they differ in deployment: BETTER_AUTH_URL
   * is where the handler lives, NEXT_PUBLIC_APP_URL is what emails link to.
   */
  trustedOrigins: [serverEnv.BETTER_AUTH_URL, clientEnv.NEXT_PUBLIC_APP_URL],

  /**
   * `nextCookies` must stay LAST. It is what lets a Server Action that calls
   * `auth.api.*` actually write the Set-Cookie header, by hooking after every
   * other plugin has had its say.
   */
  plugins: [nextCookies()],
});

export type Auth = typeof auth;
