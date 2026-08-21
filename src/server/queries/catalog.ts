import "server-only";

import { and, asc, count, eq, gte, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { appointments, services, serviceStaff, staff } from "@/db/schema";
import {
  serviceBookability,
  type ServiceBookability,
} from "@/lib/scheduling/bookability";

/**
 * Everything the services and staff screens read.
 *
 * Both screens need the same join — services, staff, and the links between
 * them — because assignment is editable from both sides and each side has to
 * show what the other side did. Loading it once, here, is what keeps the two
 * pages from disagreeing about who performs what.
 */

export interface StaffSummary {
  id: string;
  name: string;
  initials: string;
  isActive: boolean;
}

export interface ServiceRow {
  id: string;
  name: string;
  description: string | null;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  priceCents: number;
  depositType: "none" | "flat" | "percent";
  depositValue: number;
  isActive: boolean;
  displayOrder: number;
  /** Everyone assigned, active or not — the form edits the real links. */
  staff: StaffSummary[];
  /** Computed once on the server, from the same predicate the booking page uses. */
  bookability: ServiceBookability;
}

export interface StaffRow {
  id: string;
  name: string;
  email: string | null;
  initials: string;
  isActive: boolean;
  displayOrder: number;
  services: { id: string; name: string; isActive: boolean }[];
  /**
   * Appointments still ahead of them. Deactivating does not touch these — the
   * confirmation says so, and this is the number it says it about.
   */
  futureAppointmentCount: number;
}

/** Every service_staff link for one business, as `serviceId -> staffId[]`. */
async function loadLinks(businessId: string) {
  const rows = await db
    .select({
      serviceId: serviceStaff.serviceId,
      staffId: serviceStaff.staffId,
    })
    .from(serviceStaff)
    .innerJoin(services, eq(services.id, serviceStaff.serviceId))
    .where(eq(services.businessId, businessId));

  const byService = new Map<string, string[]>();
  const byStaff = new Map<string, string[]>();

  for (const row of rows) {
    byService.set(row.serviceId, [
      ...(byService.get(row.serviceId) ?? []),
      row.staffId,
    ]);
    byStaff.set(row.staffId, [
      ...(byStaff.get(row.staffId) ?? []),
      row.serviceId,
    ]);
  }

  return { byService, byStaff };
}

/** The staff list, in display order. */
export async function loadStaffSummaries(
  businessId: string,
): Promise<StaffSummary[]> {
  const rows = await db
    .select({
      id: staff.id,
      name: staff.name,
      initials: staff.initials,
      isActive: staff.isActive,
    })
    .from(staff)
    .where(eq(staff.businessId, businessId))
    .orderBy(asc(staff.displayOrder), asc(staff.name));

  return rows;
}

/** The services screen. */
export async function loadServiceRows(
  businessId: string,
  slotGranularityMin: number,
): Promise<ServiceRow[]> {
  const [serviceRows, team, links] = await Promise.all([
    db
      .select()
      .from(services)
      .where(eq(services.businessId, businessId))
      .orderBy(asc(services.displayOrder), asc(services.name)),
    loadStaffSummaries(businessId),
    loadLinks(businessId),
  ]);

  const staffById = new Map(team.map((member) => [member.id, member]));

  return serviceRows.map((service) => {
    const assigned = (links.byService.get(service.id) ?? [])
      .map((staffId) => staffById.get(staffId))
      .filter((member): member is StaffSummary => member !== undefined);

    return {
      id: service.id,
      name: service.name,
      description: service.description,
      durationMin: service.durationMin,
      bufferBeforeMin: service.bufferBeforeMin,
      bufferAfterMin: service.bufferAfterMin,
      priceCents: service.priceCents,
      depositType: service.depositType,
      depositValue: service.depositValue,
      isActive: service.isActive,
      displayOrder: service.displayOrder,
      staff: assigned,
      bookability: serviceBookability(
        {
          isActive: service.isActive,
          durationMin: service.durationMin,
          activeStaffCount: assigned.filter((member) => member.isActive).length,
        },
        slotGranularityMin,
      ),
    };
  });
}

/** The staff screen. */
export async function loadStaffRows(businessId: string): Promise<StaffRow[]> {
  const [team, serviceRows, links, futureCounts] = await Promise.all([
    db
      .select()
      .from(staff)
      .where(eq(staff.businessId, businessId))
      .orderBy(asc(staff.displayOrder), asc(staff.name)),
    db
      .select({
        id: services.id,
        name: services.name,
        isActive: services.isActive,
      })
      .from(services)
      .where(eq(services.businessId, businessId))
      .orderBy(asc(services.displayOrder), asc(services.name)),
    loadLinks(businessId),
    countFutureAppointmentsByStaff(businessId),
  ]);

  const serviceById = new Map(serviceRows.map((service) => [service.id, service]));

  return team.map((member) => ({
    id: member.id,
    name: member.name,
    email: member.email,
    initials: member.initials,
    isActive: member.isActive,
    displayOrder: member.displayOrder,
    services: (links.byStaff.get(member.id) ?? [])
      .map((serviceId) => serviceById.get(serviceId))
      .filter((service): service is { id: string; name: string; isActive: boolean } =>
        service !== undefined,
      ),
    futureAppointmentCount: futureCounts.get(member.id) ?? 0,
  }));
}

/**
 * Appointments that have not happened yet, per staff member.
 *
 * `held` and `confirmed` only. A cancelled appointment in the future is not a
 * reason to hesitate about anything, and counting it would make the
 * deactivation warning cry wolf.
 */
async function countFutureAppointmentsByStaff(
  businessId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ staffId: appointments.staffId, total: count() })
    .from(appointments)
    .where(
      and(
        eq(appointments.businessId, businessId),
        gte(appointments.startsAt, sql`now()`),
        inArray(appointments.status, ["held", "confirmed"]),
      ),
    )
    .groupBy(appointments.staffId);

  return new Map(rows.map((row) => [row.staffId, row.total]));
}

/**
 * The services a customer may actually be offered.
 *
 * The public booking page calls this instead of filtering on `is_active`
 * alone. An active service nobody active can perform must not reach the
 * picker — it would render a day with no staff to expand hours for and offer
 * an empty calendar with no explanation.
 */
export async function loadBookableServices(
  businessId: string,
  slotGranularityMin: number,
) {
  const rows = await loadServiceRows(businessId, slotGranularityMin);
  return rows.filter((service) => service.bookability.bookable);
}
