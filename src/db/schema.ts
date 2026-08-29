import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import type { NotificationPayload } from "@/lib/notifications/payload";

/* ===========================================================================
   Custom types
   =========================================================================== */

/**
 * Postgres `tstzrange`.
 *
 * Drizzle has no built-in range type, so this maps to the Postgres range
 * literal as a string, e.g. `["2026-08-20 09:00:00+00","2026-08-20 10:15:00+00")`.
 *
 * CONVENTION: every range in this schema is HALF-OPEN — inclusive lower bound,
 * exclusive upper bound, `[start, end)`. That is what makes back-to-back
 * appointments legal: an appointment ending at 10:00 and one starting at 10:00
 * do not overlap. If ranges were inclusive on both ends they would collide on
 * the shared instant and the exclusion constraint would reject a perfectly
 * valid booking.
 *
 * Construction helpers land with the booking transaction — nothing in this
 * file builds a range, it only stores one.
 */
const tstzrange = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tstzrange";
  },
});

/* ===========================================================================
   Enums
   =========================================================================== */

/** How a service's deposit is calculated. `percent` is a percent of price_cents. */
export const depositTypeEnum = pgEnum("deposit_type", [
  "none",
  "flat",
  "percent",
]);

/**
 * Appointment lifecycle.
 *
 * `held` and `confirmed` are the two statuses that BLOCK a slot — the
 * exclusion constraint added in the next step covers exactly those two.
 * Everything else is historical and blocks nothing.
 */
export const appointmentStatusEnum = pgEnum("appointment_status", [
  "held",
  "confirmed",
  "completed",
  "cancelled",
  "no_show",
]);

/** Who cancelled. Drives which email template goes out and what the admin sees. */
export const cancelledByEnum = pgEnum("cancelled_by", ["customer", "business"]);

export const notificationKindEnum = pgEnum("notification_kind", [
  "confirmation",
  "reminder",
  "reschedule",
  "cancellation",
  /**
   * The apology. Sent to a customer whose deposit was taken for a slot that
   * had already gone — the payment landed after the hold lapsed and somebody
   * else had taken the time. It carries the refund and the nearest openings.
   * Rare, and the one message in this table that must never be silently lost.
   */
  "slot_lost",
  /** To the OWNER: money went back to a customer. */
  "refund",
  /**
   * To the OWNER: somebody just booked.
   *
   * Written alongside the customer's confirmation, in the same transaction, so
   * a business always learns about a booking from the product rather than from
   * the person turning up. Last in this list because Postgres appends enum
   * labels and the order here has to match the migration.
   */
  "new_booking",
]);

/** Only email today. The enum exists so adding `sms` is a migration, not a refactor. */
export const notificationChannelEnum = pgEnum("notification_channel", ["email"]);

export const notificationStatusEnum = pgEnum("notification_status", [
  "pending",
  "sent",
  "failed",
]);

/* ===========================================================================
   Better Auth — BUSINESS OWNERS ONLY
   ---------------------------------------------------------------------------
   These four tables hold the people who RUN a business and sign in to the
   admin area. They are the entire authenticated population of this product.

   CUSTOMERS NEVER APPEAR HERE. A customer books as a guest: they are written
   to `customers` (below), identified by email within one business, and they
   manage their appointment through a signed link (`manage_token_hash` on the
   appointment) rather than a session. There is no customer login, no customer
   password, and no row in `users` for anyone who has merely booked.

   Column shapes follow Better Auth's own schema rather than this project's
   conventions, because the library owns them:
     - IDs are `text`, not `uuid`. Better Auth generates ids in application
       code and passes them on insert, so a uuid column with a DB default
       would reject them.
     - Field names are camelCase in TypeScript; the Drizzle adapter matches on
       the JS key, so these must not be renamed.

   Because the tables are named in the plural here, the Better Auth config
   needs the matching model mapping (`usePlural: true`, or explicit
   `modelName` per model) when auth is wired up.
   =========================================================================== */

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    /**
     * The stable provider-side namespace an account belongs to. For the only
     * provider enabled here it is the synthetic local issuer Better Auth
     * derives from the provider id ("credential"); an OAuth provider would put
     * its real issuer URL here.
     *
     * Required by Better Auth 1.7. Together with `account_id` it is the key
     * that recognises a returning identity, which is why the unique index
     * below covers the pair rather than either column alone.
     */
    issuer: text("issuer").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    /** Hashed by Better Auth. Email + password is the only provider we enable. */
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /** One identity per issuer. Better Auth declares this index itself. */
    unique("accounts_issuer_account_id_unique").on(t.issuer, t.accountId),
    index("accounts_user_id_idx").on(t.userId),
  ],
);

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/* ===========================================================================
   Businesses
   =========================================================================== */

export const businesses = pgTable("businesses", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** Public URL segment: /book/[slug]. */
  slug: text("slug").notNull().unique(),
  /**
   * One line under the name on the public booking page — "Family dentistry in
   * Kreuzberg, since 2009". Owner-authored, optional, and rendered only when
   * it is there: an absent sentence is an absent sentence, not a placeholder.
   * Set from the settings screen, alongside `address` below.
   */
  description: text("description"),
  /**
   * IANA timezone identifier, e.g. "Europe/Berlin". NEVER a fixed offset like
   * "+02:00" — an offset cannot survive a DST transition, and every scheduling
   * expansion in src/lib/scheduling reads this column to know which local
   * wall-clock day it is working in.
   */
  timezone: text("timezone").notNull(),
  /** ISO 4217, e.g. "EUR". Money everywhere in this schema is integer cents. */
  currency: text("currency").notNull(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  contactEmail: text("contact_email").notNull(),
  contactPhone: text("contact_phone"),
  address: text("address"),

  /* Booking policy. Read by the availability algorithm, step 4 and step 5. */

  /** Granularity of offered start times, in minutes. */
  slotGranularityMin: integer("slot_granularity_min").notNull().default(15),
  /** How far ahead of now a booking must be made. */
  minLeadTimeMin: integer("min_lead_time_min").notNull().default(120),
  /** How far into the future the calendar is open. */
  maxAdvanceDays: integer("max_advance_days").notNull().default(60),
  /** Cancellations are refused inside this many hours of the appointment. */
  cancellationWindowHours: integer("cancellation_window_hours")
    .notNull()
    .default(24),
  allowReschedule: boolean("allow_reschedule").notNull().default(true),

  /**
   * Authorize the deposit now and capture it later, instead of charging it at
   * booking. OFF BY DEFAULT, and deliberately hard to want.
   *
   * Stripe cancels an uncaptured PaymentIntent after roughly seven days, so a
   * manual-capture authorization on anything booked further ahead than a week
   * dies quietly before the appointment: no money taken, nobody told, and an
   * empty chair. Even with this on, `chooseCaptureMethod` only uses manual
   * capture for appointments inside that window and charges immediately for
   * everything else — see src/lib/payments/checkout.ts.
   */
  manualCaptureEnabled: boolean("manual_capture_enabled")
    .notNull()
    .default(false),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/* ===========================================================================
   Staff
   =========================================================================== */

export const staff = pgTable(
  "staff",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email"),
    /** Shown on booked ribbon segments, where no hue is allowed to carry meaning. */
    initials: text("initials").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
  },
  (t) => [index("staff_business_id_idx").on(t.businessId)],
);

/* ===========================================================================
   Services
   =========================================================================== */

export const services = pgTable(
  "services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),

    /** Customer-facing length. `starts_at` → `ends_at` spans exactly this. */
    durationMin: integer("duration_min").notNull(),
    /**
     * Buffers are NOT part of the customer-facing time. They are added around
     * it when the blocking range is built, so `appointments.slot` is
     * (starts_at - buffer_before) → (ends_at + buffer_after).
     */
    bufferBeforeMin: integer("buffer_before_min").notNull().default(0),
    bufferAfterMin: integer("buffer_after_min").notNull().default(0),

    /** Integer cents, always. No floats anywhere near money. */
    priceCents: integer("price_cents").notNull(),
    depositType: depositTypeEnum("deposit_type").notNull().default("none"),
    /**
     * Meaning depends on `deposit_type`: cents when `flat`, whole percent
     * (0–100) when `percent`, ignored when `none`.
     */
    depositValue: integer("deposit_value").notNull().default(0),

    isActive: boolean("is_active").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
  },
  (t) => [index("services_business_id_idx").on(t.businessId)],
);

/* ===========================================================================
   service_staff — which staff can perform which service
   =========================================================================== */

export const serviceStaff = pgTable(
  "service_staff",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
  },
  (t) => [
    unique("service_staff_service_id_staff_id_unique").on(
      t.serviceId,
      t.staffId,
    ),
    index("service_staff_staff_id_idx").on(t.staffId),
  ],
);

/* ===========================================================================
   availability_rules — recurring weekly hours
   =========================================================================== */

/**
 * READ THIS BEFORE TOUCHING start_local / end_local.
 *
 * These are PLAIN LOCAL WALL-CLOCK TIMES in the business's timezone. They are
 * `time` columns with NO timezone and NO date, and they are NOT instants.
 *
 * "We open at 9" is a fact about the clock on the wall, not about a moment in
 * time. If this were stored as an instant — "09:00Z", or any fixed offset —
 * then the day a DST transition lands the business would silently start
 * opening at 8 or at 10. Storing the wall-clock time means the rule survives
 * the transition unchanged, and the SERVER resolves it to a real instant per
 * day, in the business timezone, with a DST-correct API.
 *
 * Nothing may compare these columns against a timestamptz directly. They are
 * expanded first (src/lib/scheduling), never joined against.
 *
 * A shift that crosses midnight is expressed as end_local < start_local; the
 * expansion, not the storage, is responsible for carrying it into the next day.
 */
export const availabilityRules = pgTable(
  "availability_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    /** 0 = Sunday … 6 = Saturday, matching Postgres `extract(dow)`. */
    weekday: smallint("weekday").notNull(),
    /** Local wall-clock. See the note above. */
    startLocal: time("start_local").notNull(),
    /** Local wall-clock. See the note above. */
    endLocal: time("end_local").notNull(),
    /** Calendar dates, not instants — a rule starts applying on a local day. */
    effectiveFrom: date("effective_from").notNull(),
    /** NULL = open-ended, the rule applies indefinitely. */
    effectiveTo: date("effective_to"),
  },
  (t) => [
    index("availability_rules_staff_id_weekday_idx").on(t.staffId, t.weekday),
  ],
);

/* ===========================================================================
   time_off — holidays, breaks, business-wide closures
   =========================================================================== */

export const timeOff = pgTable(
  "time_off",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    /**
     * NULL means the whole business is closed — every staff member is
     * unavailable for this range. A value scopes the closure to one person.
     */
    staffId: uuid("staff_id").references(() => staff.id, {
      onDelete: "cascade",
    }),
    /**
     * Concrete instants, unlike availability_rules. A closure is a specific
     * period that already had its timezone resolved when it was created.
     * Half-open `[start, end)`.
     */
    range: tstzrange("range").notNull(),
    reason: text("reason"),
    /** Presentation only — an all-day block still stores a real instant range. */
    isAllDay: boolean("is_all_day").notNull().default(false),
  },
  (t) => [
    index("time_off_business_id_idx").on(t.businessId),
    index("time_off_staff_id_idx").on(t.staffId),
    index("time_off_range_idx").using("gist", t.range),
  ],
);

/* ===========================================================================
   customers — guests, not users
   =========================================================================== */

/**
 * A customer is scoped to ONE business and deduped by email within it. The
 * same person booking at two businesses is two rows, on purpose: these are
 * separate tenants and must not share contact details or notes.
 *
 * Customers have no login. See the Better Auth block above.
 */
export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    /**
     * The customer's OWN IANA zone, as their browser reported it. Nullable,
     * because it is a courtesy rather than a fact the booking depends on: a
     * manual booking has none, and a browser that refuses to say has none
     * either.
     *
     * It is used for exactly one thing — printing a second, clearly labelled
     * time in transactional email when it differs from the business's zone.
     * NOTHING IS EVER SCHEDULED IN IT. Every instant in this schema is stored
     * in UTC and every expansion happens in the business's zone; this column
     * only decides whether an email says "14:00 in Europe/Berlin — 13:00 where
     * you are" or just the first half.
     */
    timezone: text("timezone"),
    /** Private to the business. Never rendered to the customer. */
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("customers_business_id_email_unique").on(t.businessId, t.email),
  ],
);

/* ===========================================================================
   appointments — the table the whole product is about
   =========================================================================== */

export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "restrict" }),
    /**
     * NULL WHILE THE APPOINTMENT IS ONLY HELD.
     *
     * A hold is written the instant a customer taps a time, which is before
     * they have typed their name — the slot has to be genuinely reserved while
     * they fill the form in, or the form is a lie. There is no customer to
     * point at yet, and inventing a placeholder row would poison the customers
     * table (which is deduped by email) with junk that outlives the hold.
     *
     * The CHECK constraint below is what keeps this honest: only a `held` row
     * may have no customer. Anything confirmed, completed, cancelled or marked
     * no-show has one, so no query downstream has to wonder.
     */
    customerId: uuid("customer_id").references(() => customers.id, {
      onDelete: "restrict",
    }),

    /**
     * THE BLOCKING INTERVAL — and the reason this product is correct.
     *
     * `slot` is the full range the appointment occupies on the calendar,
     * INCLUDING the service's before/after buffers:
     *
     *     slot = [starts_at - buffer_before_min, ends_at + buffer_after_min)
     *
     * Buffers live in here, not in query logic, so that:
     *   1. The exclusion constraint enforces them for free. Two appointments
     *      whose customer-facing times merely touch but whose buffers overlap
     *      are rejected by the database, with no application code involved.
     *   2. No availability query has to remember to add them. Forgetting a
     *      buffer becomes impossible rather than a bug waiting to happen.
     *
     * Half-open `[start, end)`, so an appointment ending exactly where the
     * next begins is not an overlap.
     *
     * The GiST index below is what makes the `&&` overlap test — and the
     * exclusion constraint added in the next step — fast.
     */
    slot: tstzrange("slot").notNull(),

    /** Customer-facing times. These are what the confirmation email says. */
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),

    status: appointmentStatusEnum("status").notNull().default("held"),
    /**
     * Set while `status = 'held'`, NULL once confirmed.
     *
     * EXPIRY IS LAZY, and it has to be. A constraint predicate must be
     * IMMUTABLE, so `hold_expires_at > now()` cannot appear in the exclusion
     * constraint — the constraint blocks on `held` regardless of whether the
     * hold has lapsed. Two rules follow, and both are mandatory:
     *   1. Availability queries treat a hold with hold_expires_at < now() as
     *      NOT blocking.
     *   2. Booking transactions delete expired holds for that staff member and
     *      overlapping range BEFORE inserting, then let the constraint decide.
     * The nightly janitor only reclaims rows. Correctness never depends on it.
     */
    holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),

    /** Integer cents. Snapshotted at booking time so later price edits do not rewrite history. */
    priceCents: integer("price_cents").notNull(),
    depositCents: integer("deposit_cents").notNull().default(0),

    /**
     * Set the moment this appointment is handed to Stripe.
     *
     * IT ALSO CHANGES HOW THE ROW DIES. A hold with no session is deleted when
     * it lapses — it never became anything and is not history worth keeping.
     * A hold that reached a payment page is CANCELLED instead, because a
     * payment may still be in flight for it and the webhook needs a row to
     * refund against, to cancel, and to hang an apology on. A cancelled row
     * blocks nothing: the exclusion constraint only covers 'held' and
     * 'confirmed'. See `abandonHold` in src/lib/scheduling/booking.ts.
     */
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),

    /**
     * Money that went back, and when.
     *
     * Set by the `charge.refunded` webhook, and set directly by the slot-lost
     * path when this application initiates the refund itself. `refunded_at`
     * being present is also how the webhook knows a refund was OURS and does
     * not need to alarm the owner about it a second time.
     */
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    refundedCents: integer("refunded_cents"),

    /**
     * The iCalendar UID. Stable for the appointment's ENTIRE life — a reschedule
     * or a cancellation reuses this UID and bumps `ics_sequence`, which is how
     * a calendar client knows to UPDATE the existing event instead of creating
     * a second one. Changing it would leave a stale duplicate in the
     * customer's calendar forever.
     */
    icsUid: text("ics_uid").notNull().unique(),
    icsSequence: integer("ics_sequence").notNull().default(0),

    /**
     * SHA-256 of the token in the customer's manage link. The plaintext token
     * is emailed and never stored, so a database leak does not hand out the
     * ability to cancel other people's appointments.
     */
    manageTokenHash: text("manage_token_hash").notNull(),

    /** Written by the customer at booking. Shown to the business. */
    customerNote: text("customer_note"),

    /**
     * When the customer ticked the cancellation policy, and NULL when nobody
     * did.
     *
     * A hold has none — the slot is reserved before the form is opened. A
     * booking the owner enters by hand has none either, because the person who
     * agreed to the policy in that case was standing at the counter. What this
     * column is for is the third case: a customer who booked themselves and
     * later says they were never told the window. The policy text is on the
     * page, in plain words, never behind a link, and this is the timestamp
     * that says they saw it.
     */
    policyAcceptedAt: timestamp("policy_accepted_at", { withTimezone: true }),
    /** Written by the business. Never shown to the customer. */
    internalNote: text("internal_note"),

    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: cancelledByEnum("cancelled_by"),
    cancellationReason: text("cancellation_reason"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /** Admin agenda: one business, one day, in start order. */
    index("appointments_business_id_starts_at_idx").on(t.businessId, t.startsAt),
    /** Per-staff column in the agenda, and per-staff availability lookups. */
    index("appointments_staff_id_starts_at_idx").on(t.staffId, t.startsAt),
    /**
     * Overlap search. Required by the availability query's `&&` test and by
     * the exclusion constraint that the next migration adds — an exclusion
     * constraint is backed by exactly this kind of GiST index.
     */
    index("appointments_slot_gist_idx").using("gist", t.slot),
    index("appointments_customer_id_idx").on(t.customerId),
    index("appointments_service_id_idx").on(t.serviceId),
    /**
     * An anonymous appointment is a HOLD and nothing else. See the note on
     * `customer_id`. Enforced by the database rather than by convention,
     * because the moment it is only a convention some code path will confirm
     * an appointment that belongs to nobody.
     */
    check(
      "appointments_customer_required_once_booked",
      sql`${t.status} = 'held' OR ${t.customerId} IS NOT NULL`,
    ),
  ],
);

/* ===========================================================================
   notifications — a transactional OUTBOX
   ---------------------------------------------------------------------------
   Mail is never sent inline with a booking. The booking transaction writes a
   row here and commits; a worker picks it up. That way a Resend outage cannot
   roll back a confirmed appointment, and a retry cannot double-charge anyone.
   =========================================================================== */

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    kind: notificationKindEnum("kind").notNull(),
    channel: notificationChannelEnum("channel").notNull().default("email"),
    toEmail: text("to_email").notNull(),
    /** When this becomes due. A reminder is scheduled relative to starts_at. */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    status: notificationStatusEnum("status").notNull().default("pending"),
    /**
     * Facts the message needs that the appointment does not carry.
     *
     * The alternatives offered in an apology, the amount that went back on a
     * refund. Deliberately small and deliberately NOT a rendered message: the
     * template lives in code and can be fixed after a row is written, which a
     * pre-rendered body could not be.
     *
     * NEVER a secret. The manage-link token is minted when the email is
     * composed and is not persisted anywhere — the row keeps only its hash.
     */
    payload: jsonb("payload").$type<NotificationPayload>(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /** The worker's only query: what is pending and due? */
    index("notifications_status_scheduled_for_idx").on(t.status, t.scheduledFor),
    index("notifications_appointment_id_idx").on(t.appointmentId),
  ],
);

/* ===========================================================================
   webhook_events — the Stripe idempotency guard
   =========================================================================== */

/**
 * The primary key IS the Stripe event id, and that is the whole mechanism.
 *
 * Stripe retries webhooks, and will happily deliver the same event twice. The
 * webhook route INSERTs the event id here first: on conflict it returns 200
 * and does nothing, so replayed deliveries cannot confirm an appointment
 * twice or send a second confirmation email. Only a winning insert proceeds
 * to process the event.
 */
export const webhookEvents = pgTable("webhook_events", {
  /** Stripe's `evt_...` id. Deliberately not a uuid — it comes from Stripe. */
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/* ===========================================================================
   Relations
   =========================================================================== */

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  accounts: many(accounts),
  ownedBusinesses: many(businesses),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));

export const businessesRelations = relations(businesses, ({ one, many }) => ({
  owner: one(users, {
    fields: [businesses.ownerUserId],
    references: [users.id],
  }),
  staff: many(staff),
  services: many(services),
  customers: many(customers),
  appointments: many(appointments),
  timeOff: many(timeOff),
}));

export const staffRelations = relations(staff, ({ one, many }) => ({
  business: one(businesses, {
    fields: [staff.businessId],
    references: [businesses.id],
  }),
  serviceStaff: many(serviceStaff),
  availabilityRules: many(availabilityRules),
  appointments: many(appointments),
  timeOff: many(timeOff),
}));

export const servicesRelations = relations(services, ({ one, many }) => ({
  business: one(businesses, {
    fields: [services.businessId],
    references: [businesses.id],
  }),
  serviceStaff: many(serviceStaff),
  appointments: many(appointments),
}));

export const serviceStaffRelations = relations(serviceStaff, ({ one }) => ({
  service: one(services, {
    fields: [serviceStaff.serviceId],
    references: [services.id],
  }),
  staff: one(staff, {
    fields: [serviceStaff.staffId],
    references: [staff.id],
  }),
}));

export const availabilityRulesRelations = relations(
  availabilityRules,
  ({ one }) => ({
    staff: one(staff, {
      fields: [availabilityRules.staffId],
      references: [staff.id],
    }),
  }),
);

export const timeOffRelations = relations(timeOff, ({ one }) => ({
  business: one(businesses, {
    fields: [timeOff.businessId],
    references: [businesses.id],
  }),
  staff: one(staff, {
    fields: [timeOff.staffId],
    references: [staff.id],
  }),
}));

export const customersRelations = relations(customers, ({ one, many }) => ({
  business: one(businesses, {
    fields: [customers.businessId],
    references: [businesses.id],
  }),
  appointments: many(appointments),
}));

export const appointmentsRelations = relations(
  appointments,
  ({ one, many }) => ({
    business: one(businesses, {
      fields: [appointments.businessId],
      references: [businesses.id],
    }),
    staff: one(staff, {
      fields: [appointments.staffId],
      references: [staff.id],
    }),
    service: one(services, {
      fields: [appointments.serviceId],
      references: [services.id],
    }),
    customer: one(customers, {
      fields: [appointments.customerId],
      references: [customers.id],
    }),
    notifications: many(notifications),
  }),
);

export const notificationsRelations = relations(notifications, ({ one }) => ({
  appointment: one(appointments, {
    fields: [notifications.appointmentId],
    references: [appointments.id],
  }),
}));

/* ===========================================================================
   Inferred types
   =========================================================================== */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

export type Verification = typeof verifications.$inferSelect;
export type NewVerification = typeof verifications.$inferInsert;

export type Business = typeof businesses.$inferSelect;
export type NewBusiness = typeof businesses.$inferInsert;

export type Staff = typeof staff.$inferSelect;
export type NewStaff = typeof staff.$inferInsert;

export type Service = typeof services.$inferSelect;
export type NewService = typeof services.$inferInsert;

export type ServiceStaff = typeof serviceStaff.$inferSelect;
export type NewServiceStaff = typeof serviceStaff.$inferInsert;

export type AvailabilityRule = typeof availabilityRules.$inferSelect;
export type NewAvailabilityRule = typeof availabilityRules.$inferInsert;

export type TimeOff = typeof timeOff.$inferSelect;
export type NewTimeOff = typeof timeOff.$inferInsert;

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;

export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;

/** Enum value unions, for exhaustive switches in application code. */
export type DepositType = (typeof depositTypeEnum.enumValues)[number];
export type AppointmentStatus = (typeof appointmentStatusEnum.enumValues)[number];
export type CancelledBy = (typeof cancelledByEnum.enumValues)[number];
export type NotificationKind = (typeof notificationKindEnum.enumValues)[number];
export type NotificationChannel =
  (typeof notificationChannelEnum.enumValues)[number];
export type NotificationStatus =
  (typeof notificationStatusEnum.enumValues)[number];

/**
 * The two statuses that occupy a slot. The exclusion constraint added in the
 * next migration uses exactly this set; keep them in step.
 */
export const BLOCKING_STATUSES = ["held", "confirmed"] as const satisfies
  readonly AppointmentStatus[];
