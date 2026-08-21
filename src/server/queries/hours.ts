import "server-only";

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appointments,
  availabilityRules,
  customers,
  services,
  staff,
  timeOff,
} from "@/db/schema";
import {
  groupIntoVersions,
  type HoursDay,
  type HoursVersion,
} from "@/lib/scheduling/hours-versions";
import { type TimeZoneId } from "@/lib/scheduling/temporal";
import {
  countLocalDays,
  coversWholeLocalDays,
} from "@/lib/scheduling/time-off";

/**
 * Everything the hours and time-off screens read.
 *
 * Weekly rules come back as LOCAL WALL-CLOCK STRINGS, exactly as stored, and
 * are never joined against a timestamptz or converted on the way out. Time off
 * comes back as ISO instants plus the business timezone, because a closure IS
 * a concrete range. Those are two different kinds of fact and this module
 * keeps them apart on purpose.
 */

/* ---------------------------------------------------------------------------
   Weekly hours
--------------------------------------------------------------------------- */

/**
 * The version model lives in src/lib/scheduling/hours-versions.ts, as pure
 * logic with no database in it — the "which version governs today" boundary is
 * the part with an off-by-one in it, and it is tested there without needing
 * Postgres. This module only fetches the rows and hands them over.
 */
export type { HoursDay, HoursVersion };

export interface StaffHours {
  staffId: string;
  name: string;
  initials: string;
  isActive: boolean;
  versions: HoursVersion[];
}

/**
 * The weekly hours of every staff member, grouped into dated versions.
 *
 * `today` is the business's LOCAL date, resolved by the caller in the business
 * timezone — not the server's date. A shop in Auckland must not be told its
 * current version is yesterday's because the server runs on UTC.
 */
export async function loadStaffHours(
  businessId: string,
  today: string,
): Promise<StaffHours[]> {
  const team = await db
    .select({
      id: staff.id,
      name: staff.name,
      initials: staff.initials,
      isActive: staff.isActive,
    })
    .from(staff)
    .where(eq(staff.businessId, businessId))
    .orderBy(asc(staff.displayOrder), asc(staff.name));

  if (team.length === 0) {
    return [];
  }

  const rules = await db
    .select()
    .from(availabilityRules)
    .where(
      inArray(
        availabilityRules.staffId,
        team.map((member) => member.id),
      ),
    )
    .orderBy(
      asc(availabilityRules.effectiveFrom),
      asc(availabilityRules.weekday),
      asc(availabilityRules.startLocal),
    );

  const byStaff = new Map<string, typeof rules>();

  for (const rule of rules) {
    byStaff.set(rule.staffId, [...(byStaff.get(rule.staffId) ?? []), rule]);
  }

  return team.map((member) => ({
    staffId: member.id,
    name: member.name,
    initials: member.initials,
    isActive: member.isActive,
    versions: groupIntoVersions(byStaff.get(member.id) ?? [], today),
  }));
}

/* ---------------------------------------------------------------------------
   Time off
--------------------------------------------------------------------------- */

export interface TimeOffEntry {
  id: string;
  /** Null means the whole business, which is a different fact from everyone. */
  staffId: string | null;
  staffName: string | null;
  /** ISO instants. The client formats them and computes nothing. */
  startsAt: string;
  endsAt: string;
  reason: string | null;
  isAllDay: boolean;
  /** Local days covered, counted in calendar days rather than by dividing. */
  dayCount: number;
  /** True once the whole closure is behind us. */
  isPast: boolean;
}

/**
 * Closures for one business, soonest first, upcoming before past.
 *
 * Bounds are read out of the `tstzrange` with Postgres' own `lower()` and
 * `upper()` rather than parsed from the range literal in JavaScript. The
 * database already knows where the bounds are; re-deriving them from a string
 * would be a second implementation of the same fact.
 */
export async function loadTimeOff(
  businessId: string,
  timeZone: TimeZoneId,
  limit = 100,
): Promise<TimeOffEntry[]> {
  const rows = await db
    .select({
      id: timeOff.id,
      staffId: timeOff.staffId,
      staffName: staff.name,
      reason: timeOff.reason,
      isAllDay: timeOff.isAllDay,
      startsAt: sql<string>`lower(${timeOff.range})`,
      endsAt: sql<string>`upper(${timeOff.range})`,
    })
    .from(timeOff)
    .leftJoin(staff, eq(staff.id, timeOff.staffId))
    .where(eq(timeOff.businessId, businessId))
    .orderBy(sql`lower(${timeOff.range}) desc`)
    .limit(limit);

  const now = Date.now();

  return rows
    .map((row) => {
      const startsAt = new Date(row.startsAt);
      const endsAt = new Date(row.endsAt);

      return {
        id: row.id,
        staffId: row.staffId,
        staffName: row.staffName,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        reason: row.reason,
        // Trusted from the column, but only as a hint for the form; the
        // authority on "is this whole local days" is the range itself.
        isAllDay:
          row.isAllDay || coversWholeLocalDays(startsAt, endsAt, timeZone),
        dayCount: countLocalDays(startsAt, endsAt, timeZone),
        isPast: endsAt.getTime() <= now,
      };
    })
    .sort((a, b) => {
      // Upcoming first, soonest at the top; past below, most recent first.
      if (a.isPast !== b.isPast) {
        return a.isPast ? 1 : -1;
      }

      return a.isPast
        ? b.startsAt.localeCompare(a.startsAt)
        : a.startsAt.localeCompare(b.startsAt);
    });
}

/* ---------------------------------------------------------------------------
   Conflicts
--------------------------------------------------------------------------- */

export interface ConflictingAppointment {
  id: string;
  startsAt: string;
  endsAt: string;
  status: "held" | "confirmed";
  staffName: string;
  serviceName: string;
  customerName: string;
}

/**
 * Live appointments a proposed closure would land on.
 *
 * "Live" means confirmed, or held with the hold still valid — the same pair
 * the exclusion constraint covers and the same pair the availability query
 * subtracts. AN EXPIRED HOLD IS NOT A CONFLICT: it blocks nothing, and warning
 * about one would train the owner to click through the warning.
 *
 * The test is `&&` against the stored `slot`, so the buffers already folded
 * into that range are respected here for free — a closure that clips only an
 * appointment's cleanup time is still a conflict worth naming.
 */
export async function findConflictingAppointments(
  businessId: string,
  range: string,
  staffId: string | null,
): Promise<ConflictingAppointment[]> {
  const rows = await db
    .select({
      id: appointments.id,
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      status: appointments.status,
      staffName: staff.name,
      serviceName: services.name,
      customerName: customers.name,
    })
    .from(appointments)
    .innerJoin(staff, eq(staff.id, appointments.staffId))
    .innerJoin(services, eq(services.id, appointments.serviceId))
    .innerJoin(customers, eq(customers.id, appointments.customerId))
    .where(
      and(
        eq(appointments.businessId, businessId),
        // A business-wide closure hits everybody; a personal one hits one lane.
        staffId ? eq(appointments.staffId, staffId) : undefined,
        sql`${appointments.slot} && ${range}::tstzrange`,
        or(
          eq(appointments.status, "confirmed"),
          and(
            eq(appointments.status, "held"),
            sql`${appointments.holdExpiresAt} > now()`,
          ),
        ),
      ),
    )
    .orderBy(asc(appointments.startsAt))
    .limit(50);

  return rows.map((row) => ({
    id: row.id,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status as "held" | "confirmed",
    staffName: row.staffName,
    serviceName: row.serviceName,
    customerName: row.customerName,
  }));
}

/** Staff who could be given time off, plus the business-wide option. */
export async function loadTimeOffTargets(businessId: string) {
  return db
    .select({
      id: staff.id,
      name: staff.name,
      initials: staff.initials,
      isActive: staff.isActive,
    })
    .from(staff)
    .where(eq(staff.businessId, businessId))
    .orderBy(asc(staff.displayOrder), asc(staff.name));
}

/**
 * Closures overlapping a window, for the week preview.
 *
 * Includes business-wide rows (`staff_id IS NULL`) alongside the one staff
 * member's own, because both remove time from that person's day and the
 * preview has to show what the day will actually look like.
 */
export async function loadTimeOffInWindow(
  businessId: string,
  range: string,
  staffId: string | null,
) {
  const rows = await db
    .select({
      id: timeOff.id,
      staffId: timeOff.staffId,
      reason: timeOff.reason,
      startsAt: sql<string>`lower(${timeOff.range})`,
      endsAt: sql<string>`upper(${timeOff.range})`,
    })
    .from(timeOff)
    .where(
      and(
        eq(timeOff.businessId, businessId),
        sql`${timeOff.range} && ${range}::tstzrange`,
        staffId
          ? or(isNull(timeOff.staffId), eq(timeOff.staffId, staffId))
          : undefined,
      ),
    )
    .orderBy(sql`lower(${timeOff.range})`);

  return rows;
}
