"use server";

import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { FOREIGN_KEY_VIOLATION, findPostgresError } from "@/db/errors";
import { appointments, services, serviceStaff, staff } from "@/db/schema";
import {
  reorderSchema,
  staffFormSchema,
  type StaffFormInput,
} from "@/lib/validation/catalog";

import { requireOwnerBusiness } from "./context";
import type { BlockedResult, FieldErrors, MutationResult } from "./result";

/**
 * Staff mutations.
 *
 * DEACTIVATION IS NOT DELETION, and the difference is the whole point of this
 * file. A staff member who leaves still performed the appointments they
 * performed: the agenda for last March has their initials on it, the customer
 * who booked them has a confirmation naming them, and the appointments table
 * references them with ON DELETE RESTRICT so none of that can be quietly
 * unwound. Deactivating removes them from FUTURE availability and nothing
 * else.
 */

export type StaffField = "name" | "email" | "initials" | "serviceIds";

function revalidateCatalog(): void {
  revalidatePath("/admin/staff");
  revalidatePath("/admin/services");
}

function collectFieldErrors(
  issues: readonly { path: PropertyKey[]; message: string }[],
): { fieldErrors: FieldErrors<StaffField>; first: string } {
  const fieldErrors: FieldErrors<StaffField> = {};
  let first = "";

  for (const issue of issues) {
    first ||= issue.message;
    const key = issue.path[0];

    if (typeof key === "string") {
      const field = key as StaffField;
      fieldErrors[field] ??= issue.message;
    }
  }

  return { fieldErrors, first };
}

/**
 * Create or update one staff member, and replace the services they perform.
 *
 * The same link table the service form writes, edited from the other side.
 * One transaction, for the same reason: a person saved without their services
 * is a person who exists and can be booked for nothing.
 */
export async function saveStaff(
  input: StaffFormInput,
): Promise<MutationResult<StaffField>> {
  const business = await requireOwnerBusiness();

  const parsed = staffFormSchema.safeParse(input);

  if (!parsed.success) {
    const { fieldErrors, first } = collectFieldErrors(parsed.error.issues);
    return { ok: false, message: first || "Check the form.", fieldErrors };
  }

  const member = parsed.data;

  // The services must belong to THIS business — same reasoning as the staff
  // check on the service side. service_staff has no business_id of its own.
  if (member.serviceIds.length > 0) {
    const owned = await db
      .select({ id: services.id })
      .from(services)
      .where(
        and(
          eq(services.businessId, business.id),
          inArray(services.id, member.serviceIds),
        ),
      );

    if (owned.length !== member.serviceIds.length) {
      return {
        ok: false,
        message: "One of those services no longer exists. Reopen the form.",
        fieldErrors: { serviceIds: "Pick from your current services." },
      };
    }
  }

  const values = {
    name: member.name,
    email: member.email || null,
    initials: member.initials,
    isActive: member.isActive,
  };

  const staffId = await db.transaction(async (tx) => {
    let id: string;

    if (member.id) {
      const [updated] = await tx
        .update(staff)
        .set(values)
        .where(and(eq(staff.id, member.id), eq(staff.businessId, business.id)))
        .returning({ id: staff.id });

      if (!updated) {
        return null;
      }

      id = updated.id;
    } else {
      const [position] = await tx
        .select({
          next: sql<number>`coalesce(max(${staff.displayOrder}), -1) + 1`.mapWith(
            Number,
          ),
        })
        .from(staff)
        .where(eq(staff.businessId, business.id));

      const [created] = await tx
        .insert(staff)
        .values({
          ...values,
          businessId: business.id,
          displayOrder: position.next,
        })
        .returning({ id: staff.id });

      id = created.id;
    }

    await tx.delete(serviceStaff).where(eq(serviceStaff.staffId, id));

    if (member.serviceIds.length > 0) {
      await tx
        .insert(serviceStaff)
        .values(
          member.serviceIds.map((serviceId) => ({ serviceId, staffId: id })),
        );
    }

    return id;
  });

  if (!staffId) {
    return { ok: false, message: "That staff member no longer exists." };
  }

  revalidateCatalog();

  return {
    ok: true,
    id: staffId,
    message: member.id ? "Staff member saved." : `${member.name} added.`,
  };
}

/**
 * Switch a staff member on or off.
 *
 * Off means: they stop being expanded into availability, so no NEW appointment
 * can be made with them. Their existing appointments — past and future — are
 * untouched, still on the agenda, still owned by them. The message says so
 * every single time, because "deactivate" reads like "remove" and an owner
 * should never have to guess which one this product meant.
 */
export async function setStaffActive(
  staffId: string,
  isActive: boolean,
): Promise<MutationResult<StaffField>> {
  const business = await requireOwnerBusiness();

  const [updated] = await db
    .update(staff)
    .set({ isActive })
    .where(and(eq(staff.id, staffId), eq(staff.businessId, business.id)))
    .returning({ name: staff.name });

  if (!updated) {
    return { ok: false, message: "That staff member no longer exists." };
  }

  const future = isActive ? 0 : await countFutureFor(business.id, staffId);

  revalidateCatalog();

  if (isActive) {
    return { ok: true, message: `${updated.name} is bookable again.` };
  }

  return {
    ok: true,
    message:
      future > 0
        ? `${updated.name} is off the booking page. Their ${future} upcoming appointment${
            future === 1 ? " stays" : "s stay"
          } in the calendar.`
        : `${updated.name} is off the booking page. Their appointments are untouched.`,
  };
}

/**
 * Delete a staff member — refused as soon as one appointment names them.
 *
 * `appointments.staff_id` is ON DELETE RESTRICT, so this is not a policy the
 * application invented and could forget: the database will not let the row go.
 * Checking first only buys a better sentence.
 */
export async function deleteStaff(staffId: string): Promise<BlockedResult> {
  const business = await requireOwnerBusiness();

  const [existing] = await db
    .select({ id: staff.id, name: staff.name })
    .from(staff)
    .where(and(eq(staff.id, staffId), eq(staff.businessId, business.id)))
    .limit(1);

  if (!existing) {
    return { ok: false, message: "That staff member no longer exists." };
  }

  const [totals] = await db
    .select({
      total: count(),
      future: sql<number>`count(*) filter (where ${appointments.startsAt} >= now() and ${appointments.status} in ('held', 'confirmed'))`.mapWith(
        Number,
      ),
    })
    .from(appointments)
    .where(eq(appointments.staffId, staffId));

  if (totals.total > 0) {
    const plural = (n: number) => (n === 1 ? "" : "s");

    return {
      ok: false,
      blocked: {
        futureCount: totals.future,
        totalCount: totals.total,
        href: `/admin/calendar?staff=${staffId}`,
      },
      message:
        totals.future > 0
          ? `${existing.name} has ${totals.future} appointment${plural(
              totals.future,
            )} still to come, and ${totals.total} in total. Switch them off instead — they leave the booking page and every appointment stays where it is.`
          : `${existing.name} is on ${totals.total} past appointment${plural(
              totals.total,
            )}. Deleting them would erase who performed those. Switch them off instead.`,
    };
  }

  try {
    await db
      .delete(staff)
      .where(and(eq(staff.id, staffId), eq(staff.businessId, business.id)));
  } catch (error) {
    if (findPostgresError(error, FOREIGN_KEY_VIOLATION)) {
      return {
        ok: false,
        message: `${existing.name} was just booked, so they cannot be deleted. Switch them off instead.`,
      };
    }

    throw error;
  }

  revalidateCatalog();

  return { ok: true, message: `${existing.name} removed.` };
}

/** Column order in the agenda. Same completeness rule as services. */
export async function reorderStaff(
  orderedIds: string[],
): Promise<MutationResult> {
  const business = await requireOwnerBusiness();

  const parsed = reorderSchema.safeParse(orderedIds);

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0].message };
  }

  const existing = await db
    .select({ id: staff.id })
    .from(staff)
    .where(eq(staff.businessId, business.id));

  const known = new Set(existing.map((row) => row.id));

  if (
    parsed.data.length !== known.size ||
    parsed.data.some((id) => !known.has(id))
  ) {
    return {
      ok: false,
      message: "Your staff changed while you were dragging. Reload the page.",
    };
  }

  await db.transaction(async (tx) => {
    for (const [index, id] of parsed.data.entries()) {
      await tx
        .update(staff)
        .set({ displayOrder: index })
        .where(and(eq(staff.id, id), eq(staff.businessId, business.id)));
    }
  });

  revalidateCatalog();

  return { ok: true, message: "Order saved." };
}

/** Held or confirmed, starting from now. The one definition, used everywhere. */
async function countFutureFor(
  businessId: string,
  staffId: string,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(appointments)
    .where(
      and(
        eq(appointments.businessId, businessId),
        eq(appointments.staffId, staffId),
        gte(appointments.startsAt, sql`now()`),
        inArray(appointments.status, ["held", "confirmed"]),
      ),
    );

  return row?.total ?? 0;
}
