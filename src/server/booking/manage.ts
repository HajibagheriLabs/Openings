import "server-only";

import { eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import { appointments, type Appointment, type AppointmentStatus } from "@/db/schema";
import { bookingUrl } from "@/lib/booking/url";
import {
  managePermissions,
  manageTokenExpiresAt,
  type ManagePermissions,
} from "@/lib/booking/manage-policy";
import { bookingViewOf } from "@/lib/notifications/compose";
import { loadNotificationSubject } from "@/lib/notifications/context";
import type { NotificationSubject } from "@/lib/notifications/compose";
import type { EmailBooking } from "@/lib/notifications/view";
import { hashManageToken } from "@/lib/scheduling/booking";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TOKEN MODEL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `/manage/<token>` carries a secret and nothing else. No appointment id, no
 * session, no account — customers in this product are guests by design, and
 * the only login belongs to the business owner.
 *
 * WHAT IS STORED IS THE HASH. `appointments.manage_token_hash` holds the
 * SHA-256 of the token; the plaintext exists in the customer's email and
 * nowhere in this database. A dump of the appointments table hands over the
 * ability to read appointments, not the ability to cancel them.
 *
 * WHY LOOKUP BY HASH IS SAFE, given that everything else in this codebase
 * compares tokens in constant time: the previous route knew the appointment id
 * and compared the presented token against that row's hash, where a byte-wise
 * `===` would leak how much of a guess was right. Here there is no candidate
 * row until the hash finds one, so the comparison Postgres does is between two
 * HASHES. Learning that a hash shares a prefix with a stored one tells an
 * attacker nothing about the preimage — that is the property SHA-256 has and
 * the reason session stores everywhere are built this way. The index is unique,
 * so the lookup is a seek.
 *
 * EXPIRY IS DERIVED, NOT STORED — see `manageTokenExpiresAt`. A stored column
 * would be a second copy of a fact `ends_at` already carries, and the two would
 * drift the first time an appointment moved.
 *
 * ═══ ONE ANSWER FOR EVERY LINK THAT DOES NOT WORK ═══
 *
 * A token that matches nothing and a token whose appointment is long over
 * resolve to the SAME `dead` result, with the same copy, and neither names a
 * business.
 *
 * This used to be two outcomes. The expired one named the shop, printed its
 * phone number and said when the link lapsed, on the reasoning that a real
 * customer with a stale link deserves a way to reach somebody. That reasoning
 * was wrong twice over:
 *
 *   1. IT IS AN ORACLE. Two different answers tell whoever is asking whether a
 *      token names a real appointment. Against a 256-bit HMAC that is not a
 *      practical search — but a limiter that fails open, a log that records
 *      URLs, and a link forwarded in a screenshot are all real, and none of
 *      them should be able to confirm anything.
 *   2. IT LEAKS AFTER THE FACT. A manage URL outlives the appointment: in an
 *      inbox, in a browser history, in a screenshot in a group chat. Anybody
 *      who later holds that URL learned who the customer booked with, from a
 *      link that was supposed to have stopped working.
 *
 * The customer keeps the way out that always worked and never depended on this
 * page: the email the link came from names the business on every line of it.
 *
 * STILL NEVER A BARE 404. The page says what happened and what to do; it just
 * says the same thing to everybody.
 */

export type ManageResolution =
  | { status: "ok"; view: ManageView }
  /**
   * The link does not work, and that is all anybody is told.
   *
   * A mistyped token, a forged one, a link from another deployment, and a
   * genuine link whose appointment finished a month ago all arrive here and
   * are indistinguishable from outside. See the note above for why the two
   * cases were merged.
   */
  | { status: "dead" };

export interface BusinessContact {
  name: string;
  email: string;
  phone: string | null;
  /** Where to start again, if starting again is what they want. */
  bookingPath: string;
}

export interface ManageView {
  appointmentId: string;
  status: AppointmentStatus;
  /** The same facts the emails state, resolved by the same code. */
  booking: EmailBooking;
  timeZone: string;
  address: string | null;
  contact: BusinessContact;

  /** What the customer may do, and why not when they may not. */
  permissions: ManagePermissions;
  /** Hours of notice the business asks for, for the policy copy. */
  cancellationWindowHours: number;
  /** Whether an in-time cancellation puts the deposit back. */
  refundDepositOnCancel: boolean;

  /** Set only on a cancelled appointment. */
  cancelledBy: "customer" | "business" | null;
  cancellationReason: string | null;
  refundedCents: number | null;

  /** For the reschedule picker: it is scoped to exactly these. */
  businessId: string;
  serviceId: string;
  staffId: string;
  /** The appointment's own local date, where the picker opens. */
  localDate: string;
}

/**
 * Find the appointment a manage token names, or say why not.
 *
 * The token is hashed and looked up; the row's own `ends_at` decides whether
 * the link is still alive. `held` is treated as unknown rather than expired: a
 * hold is a slot reserved for eight minutes while somebody fills in a form, it
 * has never been emailed to anybody, and a link to one should not exist.
 */
export async function resolveManageToken(
  db: Db,
  token: string,
  options: { now?: Date } = {},
): Promise<ManageResolution> {
  const now = options.now ?? new Date();

  if (!token || token.length < 16 || token.length > 256) {
    /* Cheap shape check before touching the database. Every token this product
       mints is a 43-character base64url HMAC. */
    return { status: "dead" };
  }

  const [row] = await db
    .select()
    .from(appointments)
    .where(eq(appointments.manageTokenHash, hashManageToken(token)))
    .limit(1);

  if (!row || row.status === "held") {
    return { status: "dead" };
  }

  const subject = await loadNotificationSubject(db, row.id, {
    /* Nothing here composes an email; the kind only satisfies the shared
       loader, and nothing below reads it. */
    kind: "confirmation",
  });

  if (!subject) {
    /* An appointment with no customer attached. Not reachable for a confirmed
       booking — the CHECK constraint forbids it — and not something to guess
       at if it ever were. */
    return { status: "dead" };
  }

  if (now.getTime() >= manageTokenExpiresAt(row.endsAt).getTime()) {
    /* Past its life. Same answer as a token that never named anything — see
       the note at the top of this file. */
    return { status: "dead" };
  }

  return { status: "ok", view: buildView(row, subject, contactOf(subject), now) };
}

function contactOf(subject: NotificationSubject): BusinessContact {
  return {
    name: subject.business.name,
    email: subject.business.contactEmail,
    phone: subject.business.contactPhone,
    bookingPath: bookingUrl(subject.business.slug, {
      service: subject.service.id,
    }),
  };
}

function buildView(
  row: Appointment,
  subject: NotificationSubject,
  contact: BusinessContact,
  now: Date,
): ManageView {
  const booking = bookingViewOf(subject);

  return {
    appointmentId: row.id,
    status: row.status,
    booking,
    timeZone: subject.business.timeZone,
    address: subject.business.address,
    contact,

    permissions: managePermissions({
      status: row.status,
      startsAt: row.startsAt,
      cancellationWindowHours: subject.business.cancellationWindowHours,
      allowReschedule: subject.business.allowReschedule,
      contactPhone: subject.business.contactPhone,
      now,
    }),
    cancellationWindowHours: subject.business.cancellationWindowHours,
    refundDepositOnCancel: subject.business.refundDepositOnCancel,

    cancelledBy: row.cancelledBy,
    cancellationReason: row.cancellationReason,
    refundedCents: row.refundedCents,

    businessId: row.businessId,
    serviceId: subject.service.id,
    staffId: row.staffId,
    localDate: localDateIn(row.startsAt, subject.business.timeZone),
  };
}

/**
 * The appointment's own calendar date in the business's zone.
 *
 * Formatting, not arithmetic: `en-CA` renders ISO-ordered parts, so this is a
 * date the picker can open on without anybody adding an offset to anything.
 */
function localDateIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}
