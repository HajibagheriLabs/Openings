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
 * ═══ NEVER A BARE 404 ═══
 *
 * Every failure below resolves to a `ManageResolution` with something to say.
 * An expired link names the business and its phone number, because the row is
 * still there and we know exactly who they booked with. A token that matches
 * nothing genuinely cannot name a business — that is not evasiveness, it is the
 * truth, and the copy says what to do instead. A 404 would answer neither.
 */

export type ManageResolution =
  | { status: "ok"; view: ManageView }
  /**
   * The row is there and the token matched, but the link is past its life.
   * We know the business, so the page can hand over their details.
   */
  | { status: "expired"; expiredAt: Date; contact: BusinessContact }
  /**
   * Nothing matched. A mistyped link, a forged one, or a link from another
   * deployment. There is no business to name, and pretending otherwise would
   * be inventing one.
   */
  | { status: "unknown" };

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
    return { status: "unknown" };
  }

  const [row] = await db
    .select()
    .from(appointments)
    .where(eq(appointments.manageTokenHash, hashManageToken(token)))
    .limit(1);

  if (!row || row.status === "held") {
    return { status: "unknown" };
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
    return { status: "unknown" };
  }

  const contact = contactOf(subject);
  const expiresAt = manageTokenExpiresAt(row.endsAt);

  if (now.getTime() >= expiresAt.getTime()) {
    return { status: "expired", expiredAt: expiresAt, contact };
  }

  return { status: "ok", view: buildView(row, subject, contact, now) };
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
