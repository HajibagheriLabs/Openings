import "server-only";

import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

import { db } from "@/db";
import { availabilityRules, businesses, staff } from "@/db/schema";
import { localDateOf } from "@/lib/scheduling/local-minutes";
import {
  formatLocalMinuteRange,
  intervalLength,
  parseLocalTime,
  timeColumnToLocal,
  WEEKDAYS_DISPLAY_ORDER,
  WEEKDAY_NAMES,
} from "@/lib/scheduling/week";

/**
 * What the PUBLIC booking page is allowed to know about a business.
 *
 * An explicit column list rather than `select()`, because this row is rendered
 * to anybody on the internet who guesses a slug. `owner_user_id` is not a
 * secret worth much, but sending it to every visitor because the query was
 * lazy is the habit that eventually ships something that is. The page can only
 * leak what the loader hands it.
 */
export interface PublicBusiness {
  id: string;
  name: string;
  slug: string;
  /** One line under the name. Null when the owner has not written one. */
  description: string | null;
  /** Where to turn up. Null until it is filled in. */
  address: string | null;
  contactEmail: string;
  contactPhone: string | null;
  /** IANA identifier. Every time on the page is expressed in this zone. */
  timezone: string;
  currency: string;
  slotGranularityMin: number;
  minLeadTimeMin: number;
  maxAdvanceDays: number;
  /** Cancellations are refused inside this many hours. Stated on the form. */
  cancellationWindowHours: number;
  allowReschedule: boolean;
}

/**
 * A business by its public slug, or null.
 *
 * Null is a genuine 404 and the page treats it as one: there is no such
 * booking page. It is not an error state, an empty state or a redirect to
 * somewhere more useful — a mistyped address should say so and stop.
 */
export async function loadPublicBusiness(
  slug: string,
): Promise<PublicBusiness | null> {
  const [business] = await db
    .select({
      id: businesses.id,
      name: businesses.name,
      slug: businesses.slug,
      description: businesses.description,
      address: businesses.address,
      contactEmail: businesses.contactEmail,
      contactPhone: businesses.contactPhone,
      timezone: businesses.timezone,
      currency: businesses.currency,
      slotGranularityMin: businesses.slotGranularityMin,
      minLeadTimeMin: businesses.minLeadTimeMin,
      maxAdvanceDays: businesses.maxAdvanceDays,
      cancellationWindowHours: businesses.cancellationWindowHours,
      allowReschedule: businesses.allowReschedule,
    })
    .from(businesses)
    .where(eq(businesses.slug, slug))
    .limit(1);

  return business ?? null;
}

/* ===========================================================================
   Opening hours, for the front page
   =========================================================================== */

export interface PublicOpeningDay {
  weekday: number;
  /** "Monday". */
  label: string;
  /** "09:00 – 17:00", possibly several. Empty means closed. */
  intervals: string[];
}

/**
 * When the business is open, as a customer would read it off a door.
 *
 * ═══ WALL CLOCK, AND NOT ONE INSTANT IN SIGHT ═══
 *
 * "We open at nine" is a fact about the clock on the wall. It is stored that
 * way (`availability_rules.start_local` is a `time` with no date and no zone),
 * and it is rendered that way — no instants are constructed anywhere in this
 * function, because there is no day for them to be on. A sign in a window does
 * not mean a different thing in March and in July, and neither does this.
 *
 * The one place a timezone appears is choosing WHICH VERSION of the hours is
 * in force: effective dating is by local calendar date, so the business's own
 * today has to be resolved in its own zone. A shop in Auckland must not show
 * yesterday's hours because the server runs on UTC.
 *
 * ═══ THE UNION OF EVERYBODY'S SHIFT ═══
 *
 * Merged across active staff, because "we are open" is a statement about the
 * business and not about a rota. A customer is entitled to know the door is
 * unlocked at eight; they are not entitled to know it is Tiago until eleven.
 * Two staff working 09:00–13:00 and 12:00–18:00 produce one line reading
 * 09:00 – 18:00, which is what the door would say.
 */
export async function loadPublicOpeningHours(
  businessId: string,
  timeZone: string,
  now: Date = new Date(),
): Promise<PublicOpeningDay[]> {
  const today = localDateOf(now, timeZone);

  const rules = await db
    .select({
      weekday: availabilityRules.weekday,
      startLocal: availabilityRules.startLocal,
      endLocal: availabilityRules.endLocal,
    })
    .from(availabilityRules)
    .innerJoin(staff, eq(staff.id, availabilityRules.staffId))
    .where(
      and(
        eq(staff.businessId, businessId),
        /* A deactivated stylist's hours are not the shop's hours. */
        eq(staff.isActive, true),
        /* The version governing TODAY. A future version exists the moment an
           owner schedules a change, and publishing it early would tell
           customers the shop opens at eight three weeks before it does. */
        lte(availabilityRules.effectiveFrom, sql`${today}::date`),
        or(
          isNull(availabilityRules.effectiveTo),
          sql`${availabilityRules.effectiveTo} >= ${today}::date`,
        ),
      ),
    );

  /** Minute spans per weekday, before merging. */
  const byWeekday = new Map<number, { start: number; length: number }[]>();

  for (const rule of rules) {
    const start = parseLocalTime(timeColumnToLocal(rule.startLocal));
    const end = parseLocalTime(timeColumnToLocal(rule.endLocal));

    if (start === null || end === null) {
      continue;
    }

    const length = intervalLength(start, end);

    if (length === null) {
      continue;
    }

    byWeekday.set(rule.weekday, [
      ...(byWeekday.get(rule.weekday) ?? []),
      { start, length },
    ]);
  }

  return WEEKDAYS_DISPLAY_ORDER.map((weekday) => ({
    weekday,
    label: WEEKDAY_NAMES[weekday].label,
    intervals: mergeMinuteSpans(byWeekday.get(weekday) ?? []).map((span) =>
      formatLocalMinuteRange(span.start, span.length),
    ),
  }));
}

/**
 * Merge overlapping and touching wall-clock spans on one day.
 *
 * TOUCHING COUNTS, so 09:00–13:00 and 13:00–18:00 become one line rather than
 * two that a reader has to add together. A genuine break — 09:00–13:00 and
 * 14:00–18:00 — stays two lines, because that is a fact the customer needs.
 *
 * A shift running past midnight is left alone: its length carries it past
 * 1440 and `formatLocalMinuteRange` wraps the label to "22:00 – 02:00", which
 * is how a door sign would put it.
 */
function mergeMinuteSpans(
  spans: { start: number; length: number }[],
): { start: number; length: number }[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];

  for (const span of sorted) {
    const last = merged[merged.length - 1];
    const end = span.start + span.length;

    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, end);
    } else {
      merged.push({ start: span.start, end });
    }
  }

  return merged.map((span) => ({
    start: span.start,
    length: span.end - span.start,
  }));
}

/* ===========================================================================
   The demo businesses, for the landing page
   =========================================================================== */

export interface DemoBusinessCard {
  slug: string;
  name: string;
  description: string | null;
  timezone: string;
  /** Where the visitor is, roughly — "Lisboa, Portugal" off the address. */
  place: string | null;
}

/**
 * The seeded businesses, if there are any.
 *
 * The landing page links straight into them, so a visitor who has never seen
 * this product lands on a working booking page rather than a marketing claim.
 * An empty list is ordinary — a fresh clone that has not run `npm run db:seed`
 * has no demo — and the page says so plainly rather than linking nowhere.
 */
export async function loadDemoBusinesses(): Promise<DemoBusinessCard[]> {
  const rows = await db
    .select({
      slug: businesses.slug,
      name: businesses.name,
      description: businesses.description,
      timezone: businesses.timezone,
      address: businesses.address,
    })
    .from(businesses)
    .where(eq(businesses.isDemo, true))
    .orderBy(businesses.createdAt);

  return rows.map((row) => ({
    slug: row.slug,
    name: row.name,
    description: row.description,
    timezone: row.timezone,
    /* The last two lines of the address — the city and the country — which is
       as much as a card needs and all a stranger reads anyway. */
    place: row.address
      ? row.address.split("\n").slice(-2).join(", ").trim() || null
      : null,
  }));
}
