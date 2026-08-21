"use server";

import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { FOREIGN_KEY_VIOLATION, findPostgresError } from "@/db/errors";
import { appointments, services, serviceStaff, staff } from "@/db/schema";
import { parseMoneyToCents } from "@/lib/money";
import {
  buildServiceFormSchema,
  reorderSchema,
  type ServiceFormInput,
} from "@/lib/validation/catalog";

import { requireOwnerBusiness } from "./context";
import type { BlockedResult, FieldErrors, MutationResult } from "./result";

/**
 * Service mutations.
 *
 * THE GUARDS ARE HERE, not in the form. The form repeats them so the owner
 * hears about a problem while typing, but a Server Action is a public HTTP
 * endpoint reachable with curl, and every rule that matters — the duration
 * grid, ownership of the staff being assigned, the refusal to delete history —
 * is enforced on this side of the wire.
 */

export type ServiceField =
  | "name"
  | "description"
  | "durationMin"
  | "bufferBeforeMin"
  | "bufferAfterMin"
  | "price"
  | "deposit"
  | "staffIds";

/** Both screens show assignments, so both are stale after any of this. */
function revalidateCatalog(): void {
  revalidatePath("/admin/services");
  revalidatePath("/admin/staff");
}

/** Zod issues to `{ field: message }`, first message per field wins. */
function collectFieldErrors(
  issues: readonly { path: PropertyKey[]; message: string }[],
): { fieldErrors: FieldErrors<ServiceField>; first: string } {
  const fieldErrors: FieldErrors<ServiceField> = {};
  let first = "";

  for (const issue of issues) {
    first ||= issue.message;
    const key = issue.path[0];

    if (typeof key === "string") {
      const field = key as ServiceField;
      fieldErrors[field] ??= issue.message;
    }
  }

  return { fieldErrors, first };
}

/**
 * Create or update one service, and replace its staff assignments.
 *
 * One transaction. A service whose row saved but whose assignments did not is
 * a service that silently stopped being bookable, and the owner would have no
 * way to tell that apart from a service they had simply not assigned yet.
 */
export async function saveService(
  input: ServiceFormInput,
): Promise<MutationResult<ServiceField>> {
  const business = await requireOwnerBusiness();

  const parsed = buildServiceFormSchema(business.slotGranularityMin).safeParse(
    input,
  );

  if (!parsed.success) {
    const { fieldErrors, first } = collectFieldErrors(parsed.error.issues);
    return { ok: false, message: first || "Check the form.", fieldErrors };
  }

  const service = parsed.data;

  /**
   * The assigned staff must belong to THIS business.
   *
   * Without this check the ids come straight from the request body, and
   * service_staff has no business_id of its own to constrain them — the link
   * table would happily record that another business's employee performs this
   * service, and that person would then appear in the availability expansion.
   */
  if (service.staffIds.length > 0) {
    const owned = await db
      .select({ id: staff.id })
      .from(staff)
      .where(
        and(
          eq(staff.businessId, business.id),
          inArray(staff.id, service.staffIds),
        ),
      );

    if (owned.length !== service.staffIds.length) {
      return {
        ok: false,
        message: "One of those staff members no longer exists. Reopen the form.",
        fieldErrors: { staffIds: "Pick from your current staff." },
      };
    }
  }

  // Non-null: the schema's superRefine already rejected anything unparseable.
  const priceCents = parseMoneyToCents(service.price)!;
  const depositValue =
    service.depositType === "flat"
      ? parseMoneyToCents(service.deposit)!
      : service.depositType === "percent"
        ? Number(service.deposit)
        : 0;

  const values = {
    name: service.name,
    description: service.description || null,
    durationMin: service.durationMin,
    bufferBeforeMin: service.bufferBeforeMin,
    bufferAfterMin: service.bufferAfterMin,
    priceCents,
    depositType: service.depositType,
    depositValue,
    isActive: service.isActive,
  };

  const serviceId = await db.transaction(async (tx) => {
    let id: string;

    if (service.id) {
      // business_id is part of the WHERE, not a check afterwards: an id from
      // another tenant updates zero rows instead of the wrong row.
      const [updated] = await tx
        .update(services)
        .set(values)
        .where(
          and(
            eq(services.id, service.id),
            eq(services.businessId, business.id),
          ),
        )
        .returning({ id: services.id });

      if (!updated) {
        return null;
      }

      id = updated.id;
    } else {
      // New services land at the bottom of the list the owner is looking at.
      const [position] = await tx
        .select({
          next: sql<number>`coalesce(max(${services.displayOrder}), -1) + 1`.mapWith(
            Number,
          ),
        })
        .from(services)
        .where(eq(services.businessId, business.id));

      const [created] = await tx
        .insert(services)
        .values({
          ...values,
          businessId: business.id,
          displayOrder: position.next,
        })
        .returning({ id: services.id });

      id = created.id;
    }

    // Replace rather than diff. The set is tiny, a link row carries nothing
    // but the pair itself, and a delete-then-insert cannot leave a stale row
    // behind the way a partial diff can.
    await tx.delete(serviceStaff).where(eq(serviceStaff.serviceId, id));

    if (service.staffIds.length > 0) {
      await tx
        .insert(serviceStaff)
        .values(
          service.staffIds.map((staffId) => ({ serviceId: id, staffId })),
        );
    }

    return id;
  });

  if (!serviceId) {
    return { ok: false, message: "That service no longer exists." };
  }

  revalidateCatalog();

  return {
    ok: true,
    id: serviceId,
    message: service.id ? "Service saved." : `${service.name} added.`,
  };
}

/** The list's active switch. Separate from the form so a toggle stays one click. */
export async function setServiceActive(
  serviceId: string,
  isActive: boolean,
): Promise<MutationResult<ServiceField>> {
  const business = await requireOwnerBusiness();

  const [updated] = await db
    .update(services)
    .set({ isActive })
    .where(and(eq(services.id, serviceId), eq(services.businessId, business.id)))
    .returning({ name: services.name });

  if (!updated) {
    return { ok: false, message: "That service no longer exists." };
  }

  revalidateCatalog();

  return {
    ok: true,
    message: isActive
      ? `${updated.name} is bookable again.`
      : `${updated.name} is switched off. Existing appointments are unchanged.`,
  };
}

/**
 * Delete a service — refused when any appointment points at it.
 *
 * A service is not a label on an appointment, it is the row that says what was
 * booked, for how long, and at what price. `appointments.service_id` is ON
 * DELETE RESTRICT precisely so that history cannot be dissolved by tidying up
 * a menu. This checks first so the refusal is a sentence with a number and a
 * link, rather than a constraint error.
 */
export async function deleteService(serviceId: string): Promise<BlockedResult> {
  const business = await requireOwnerBusiness();

  const [existing] = await db
    .select({ id: services.id, name: services.name })
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.businessId, business.id)))
    .limit(1);

  if (!existing) {
    return { ok: false, message: "That service no longer exists." };
  }

  const [totals] = await db
    .select({
      total: count(),
      future: sql<number>`count(*) filter (where ${appointments.startsAt} >= now() and ${appointments.status} in ('held', 'confirmed'))`.mapWith(
        Number,
      ),
    })
    .from(appointments)
    .where(eq(appointments.serviceId, serviceId));

  if (totals.total > 0) {
    const plural = (n: number) => (n === 1 ? "" : "s");

    return {
      ok: false,
      blocked: {
        futureCount: totals.future,
        totalCount: totals.total,
        href: `/admin/calendar?service=${serviceId}`,
      },
      message:
        totals.future > 0
          ? `${existing.name} has ${totals.future} appointment${plural(
              totals.future,
            )} still to come. Switch it off instead — it leaves your booking page and those appointments stay exactly as they are.`
          : `${existing.name} is on ${totals.total} past appointment${plural(
              totals.total,
            )}. Deleting it would erase what those customers booked. Switch it off instead.`,
    };
  }

  try {
    await db
      .delete(services)
      .where(
        and(eq(services.id, serviceId), eq(services.businessId, business.id)),
      );
  } catch (error) {
    // The count above and this delete are two statements, so an appointment
    // can be booked in between. The constraint is the real arbiter; this turns
    // its complaint back into the same sentence.
    if (findPostgresError(error, FOREIGN_KEY_VIOLATION)) {
      return {
        ok: false,
        message: `${existing.name} was just booked, so it cannot be deleted. Switch it off instead.`,
      };
    }

    throw error;
  }

  revalidateCatalog();

  return { ok: true, message: `${existing.name} deleted.` };
}

/**
 * Persist a new display order.
 *
 * The ordering has to be COMPLETE. Renumbering a subset would leave the
 * untouched rows on their old positions, and two services claiming position 3
 * sort by whatever the tiebreaker happens to be — which is how a list starts
 * shuffling itself between page loads.
 */
export async function reorderServices(
  orderedIds: string[],
): Promise<MutationResult> {
  const business = await requireOwnerBusiness();

  const parsed = reorderSchema.safeParse(orderedIds);

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0].message };
  }

  const existing = await db
    .select({ id: services.id })
    .from(services)
    .where(eq(services.businessId, business.id));

  const known = new Set(existing.map((row) => row.id));

  if (
    parsed.data.length !== known.size ||
    parsed.data.some((id) => !known.has(id))
  ) {
    return {
      ok: false,
      message: "Your services changed while you were dragging. Reload the page.",
    };
  }

  await db.transaction(async (tx) => {
    for (const [index, id] of parsed.data.entries()) {
      await tx
        .update(services)
        .set({ displayOrder: index })
        .where(and(eq(services.id, id), eq(services.businessId, business.id)));
    }
  });

  revalidateCatalog();

  return { ok: true, message: "Order saved." };
}

/**
 * How many appointments still lie ahead for one service.
 *
 * Lives beside the delete guard on purpose, so the two definitions of "future
 * appointment" — held or confirmed, starting from now — cannot drift apart.
 */
export async function countFutureAppointmentsForService(
  serviceId: string,
): Promise<number> {
  const business = await requireOwnerBusiness();

  const [row] = await db
    .select({ total: count() })
    .from(appointments)
    .where(
      and(
        eq(appointments.businessId, business.id),
        eq(appointments.serviceId, serviceId),
        gte(appointments.startsAt, sql`now()`),
        inArray(appointments.status, ["held", "confirmed"]),
      ),
    );

  return row?.total ?? 0;
}
