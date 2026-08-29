import "server-only";

import { createHmac } from "node:crypto";

import { clientEnv } from "@/env";
import { serverEnv } from "@/env.server";

/**
 * The customer's proof that an appointment is theirs — and how a background
 * worker is able to rebuild it hours after the booking was made.
 *
 * ═══ WHY THE TOKEN IS DERIVED RATHER THAN RANDOM ═══
 *
 * The row stores only the SHA-256 of the manage token (see `hashManageToken`
 * in src/lib/scheduling/booking.ts). That is the right thing to store, and it
 * is also a problem: the outbox worker runs minutes — or a day — later, in
 * another process, and a hash cannot be put in a link.
 *
 * Three ways out, and only one of them is any good:
 *
 *   1. Put the plaintext in the notification row. That turns the outbox into a
 *      table of live secrets, backed up and logged alongside everything else.
 *      No.
 *   2. Let the worker mint a FRESH token and rewrite `manage_token_hash`. This
 *      is the obvious answer and it is wrong: the customer's browser holds the
 *      previous token in the hold cookie for a day after booking, and rotating
 *      it turns their own confirmation screen into a stranger's.
 *   3. Make the token a deterministic function of something already on the row
 *      and a secret already in the environment. Nothing extra is stored,
 *      nothing is rotated, and the token in the cookie, the token in the email
 *      and the token the .ics route checks are all literally the same string.
 *
 * This module is (3). `manage_token_hash` is unchanged and `manageTokenMatches`
 * remains the only authority on whether a presented token is valid — deriving
 * it just means the plaintext can be recomputed instead of remembered.
 *
 * The input is `ics_uid`, because it is minted in application code BEFORE the
 * INSERT (so the token exists before the row does), it is unique, and it never
 * changes for the life of the appointment — which is exactly how long the link
 * has to keep working.
 *
 * WHAT AN ATTACKER WOULD NEED: the secret. A UID on its own yields nothing —
 * this is HMAC-SHA256, not a hash of a guessable value. The UID does travel to
 * the customer inside their calendar invite, which is the same exposure the
 * link itself has, and neither is any use without the key.
 *
 * ROTATING THE SECRET INVALIDATES EVERY OUTSTANDING LINK. Stated here rather
 * than discovered: changing BETTER_AUTH_SECRET already signs every owner out,
 * and it will additionally make manage links in already-delivered email stop
 * working. Appointments are days-to-weeks objects, so the blast radius is
 * small — but it is not zero.
 */

/**
 * Domain separation. The same secret signs Better Auth sessions, and a value
 * derived from it must not be usable in that context — the label is what keeps
 * the two keyspaces apart, and the version lets the scheme change later
 * without ambiguity about which one produced a given token.
 */
const MANAGE_TOKEN_LABEL = "openings:manage-link:v1";

/**
 * The plaintext manage token for an appointment.
 *
 * base64url, so it survives a query string, an email client's URL detection
 * and a copy-paste out of a plain-text part without any escaping.
 */
export function deriveManageToken(icsUid: string): string {
  return createHmac("sha256", serverEnv.BETTER_AUTH_SECRET)
    .update(`${MANAGE_TOKEN_LABEL}:${icsUid}`)
    .digest("base64url");
}

/**
 * The public origin links are built against.
 *
 * Configuration rather than a request header: the worker has no request, and a
 * link in an email must not depend on which host happened to trigger the
 * send.
 */
export function appOrigin(): string {
  return clientEnv.NEXT_PUBLIC_APP_URL;
}
