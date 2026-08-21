"use server";

import { and, asc, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { availabilityRules, staff } from "@/db/schema";
import { Temporal } from "@/lib/scheduling/temporal";
import { localToTimeColumn } from "@/lib/scheduling/week";
import {
  weeklyHoursSchema,
  type WeeklyHoursInput,
} from "@/lib/validation/hours";

import { requireOwnerBusiness } from "./context";
import type { MutationResult } from "./result";

/**
 * Weekly hours, stored as dated versions.
 *
 * WHY VERSIONS RATHER THAN AN EDITABLE GRID
 * -----------------------------------------
 * `availability_rules` carries `effective_from` / `effective_to` so an owner
 * can say "from 1 October we open at eight" without touching the hours that
 * governed September. If the grid were simply overwritten, every past day
 * would retroactively claim hours it never had — and since the availability
 * expansion reads these rules for any date it is asked about, last month's
 * agenda would quietly redraw itself.
 *
 * So a save writes a VERSION: every rule sharing one `effective_from`. The
 * chain is then resealed — each version's `effective_to` is set to the day
 * before the next one starts — so the timeline is contiguous, gapless, and
 * never assembled by hand.
 *
 * `effective_to` is INCLUSIVE: it is the last local day the version applies.
 * Owners think "these hours run through 30 September", and a date column that
 * means "up to but not including 1 October" reads wrong in every admin screen
 * that ever shows it.
 */

export type HoursField = "effectiveFrom" | "days" | "staffId";

export interface HoursMutationResult {
  ok: boolean;
  message: string;
  /** Weekday index to message, so the grid can mark the offending rows. */
  dayErrors?: Record<number, string>;
  field?: HoursField;
}

/**
 * Save one version of a staff member's week.
 *
 * The whole thing is one transaction. A version whose Monday saved and whose
 * Tuesday did not is a week that never existed, and the availability
 * expansion would serve it to customers without any way to tell it was half
 * written.
 */
export async function saveWeeklyHours(
  input: WeeklyHoursInput,
): Promise<HoursMutationResult> {
  const business = await requireOwnerBusiness();

  const parsed = weeklyHoursSchema.safeParse(input);

  if (!parsed.success) {
    const dayErrors: Record<number, string> = {};
    let first = "";

    for (const issue of parsed.error.issues) {
      first ||= issue.message;

      // Paths are ["days", <weekday>, ...] — see the schema's superRefine.
      if (issue.path[0] === "days" && typeof issue.path[1] === "number") {
        dayErrors[issue.path[1]] ??= issue.message;
      }
    }

    return { ok: false, message: first || "Check the week.", dayErrors };
  }

  const { staffId, effectiveFrom, days } = parsed.data;

  // Ownership is part of the lookup, so a staff id from another business finds
  // nothing rather than being checked afterwards.
  const [member] = await db
    .select({ id: staff.id, name: staff.name })
    .from(staff)
    .where(and(eq(staff.id, staffId), eq(staff.businessId, business.id)))
    .limit(1);

  if (!member) {
    return {
      ok: false,
      message: "That staff member no longer exists.",
      field: "staffId",
    };
  }

  /**
   * THE LOCAL DATE IN THE BUSINESS'S OWN TIMEZONE, not the server's.
   *
   * A shop in Auckland saving hours at 09:00 local is on a date the UTC server
   * has not reached yet. Comparing against the server's today would refuse a
   * perfectly valid "starting today" as being in the past.
   */
  const today = Temporal.Now.plainDateISO(business.timezone).toString();

  if (effectiveFrom < today) {
    return {
      ok: false,
      field: "effectiveFrom",
      message:
        "Hours can only start today or later. Days that have already happened keep the hours they were booked under — set a start date instead and the old pattern stays as history.",
    };
  }

  await db.transaction(async (tx) => {
    // Replacing this version, if it already exists. Delete-then-insert rather
    // than a diff: the rows carry nothing but the interval itself, and a diff
    // could leave a stale one behind.
    await tx
      .delete(availabilityRules)
      .where(
        and(
          eq(availabilityRules.staffId, staffId),
          eq(availabilityRules.effectiveFrom, effectiveFrom),
        ),
      );

    const rows = days.flatMap((day) =>
      day.intervals.map((interval) => ({
        staffId,
        weekday: day.weekday,
        // Stored exactly as typed. Local wall-clock, never an instant.
        startLocal: localToTimeColumn(interval.startLocal),
        endLocal: localToTimeColumn(interval.endLocal),
        effectiveFrom,
        // Set by the reseal below, never here — one writer for this column.
        effectiveTo: null as string | null,
      })),
    );

    if (rows.length > 0) {
      await tx.insert(availabilityRules).values(rows);
    }

    await resealVersions(tx, staffId);
  });

  revalidateHours();

  return {
    ok: true,
    message:
      effectiveFrom > today
        ? `Hours saved. They take effect on ${effectiveFrom}.`
        : "Hours saved. They are in effect now.",
  };
}

/**
 * Delete a whole version.
 *
 * Only a version that has not started yet. One that is in force or already
 * past governed real days — days customers booked against — and removing it
 * would rewrite what those days looked like. The way to stop hours applying is
 * to add a version that supersedes them, which is exactly what the editor
 * does.
 */
export async function deleteHoursVersion(
  staffId: string,
  effectiveFrom: string,
): Promise<MutationResult> {
  const business = await requireOwnerBusiness();

  const [member] = await db
    .select({ id: staff.id, name: staff.name })
    .from(staff)
    .where(and(eq(staff.id, staffId), eq(staff.businessId, business.id)))
    .limit(1);

  if (!member) {
    return { ok: false, message: "That staff member no longer exists." };
  }

  const today = Temporal.Now.plainDateISO(business.timezone).toString();

  if (effectiveFrom <= today) {
    return {
      ok: false,
      message:
        "These hours are already in force, so they cannot be removed — days have been booked under them. Add a new set starting today or later to replace them.",
    };
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(availabilityRules)
      .where(
        and(
          eq(availabilityRules.staffId, staffId),
          eq(availabilityRules.effectiveFrom, effectiveFrom),
        ),
      );

    await resealVersions(tx, staffId);
  });

  revalidateHours();

  return { ok: true, message: `The hours starting ${effectiveFrom} are gone.` };
}

/**
 * Recompute `effective_to` across a staff member's whole timeline.
 *
 * Each version runs until the day before the next begins; the last one runs
 * open-ended. Doing this in one place, after every write, is what guarantees
 * the chain has no gaps and no overlaps — and it means no caller ever has to
 * compute a boundary date, which is the calculation that would eventually be
 * done with a fixed 24-hour subtraction and be wrong across a DST change.
 * (`PlainDate.subtract` is calendar arithmetic and has no such hazard.)
 */
async function resealVersions(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  staffId: string,
): Promise<void> {
  const rows = await tx
    .selectDistinct({ effectiveFrom: availabilityRules.effectiveFrom })
    .from(availabilityRules)
    .where(eq(availabilityRules.staffId, staffId))
    .orderBy(asc(availabilityRules.effectiveFrom));

  const starts = rows.map((row) => row.effectiveFrom);

  for (const [index, effectiveFrom] of starts.entries()) {
    const next = starts[index + 1];
    const effectiveTo = next
      ? Temporal.PlainDate.from(next).subtract({ days: 1 }).toString()
      : null;

    await tx
      .update(availabilityRules)
      .set({ effectiveTo })
      .where(
        and(
          eq(availabilityRules.staffId, staffId),
          eq(availabilityRules.effectiveFrom, effectiveFrom),
        ),
      );
  }
}

/**
 * Copy one staff member's current week onto others.
 *
 * The version is written for each target with the SAME `effective_from`, so a
 * shop where everyone works the same hours is configured once. Each target's
 * own chain is resealed independently — they may have their own future
 * versions, and this must not disturb them.
 */
export async function copyWeekToStaff(
  input: WeeklyHoursInput,
  targetStaffIds: string[],
): Promise<HoursMutationResult> {
  const business = await requireOwnerBusiness();

  const parsed = weeklyHoursSchema.safeParse(input);

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0].message };
  }

  if (targetStaffIds.length === 0) {
    return { ok: false, message: "Pick at least one person to copy to." };
  }

  const owned = await db
    .select({ id: staff.id })
    .from(staff)
    .where(
      and(eq(staff.businessId, business.id), inArray(staff.id, targetStaffIds)),
    );

  if (owned.length !== targetStaffIds.length) {
    return {
      ok: false,
      message: "One of those staff members no longer exists. Reload the page.",
    };
  }

  const { effectiveFrom, days } = parsed.data;
  const today = Temporal.Now.plainDateISO(business.timezone).toString();

  if (effectiveFrom < today) {
    return {
      ok: false,
      field: "effectiveFrom",
      message: "Hours can only start today or later.",
    };
  }

  await db.transaction(async (tx) => {
    for (const staffId of targetStaffIds) {
      await tx
        .delete(availabilityRules)
        .where(
          and(
            eq(availabilityRules.staffId, staffId),
            eq(availabilityRules.effectiveFrom, effectiveFrom),
          ),
        );

      const rows = days.flatMap((day) =>
        day.intervals.map((interval) => ({
          staffId,
          weekday: day.weekday,
          startLocal: localToTimeColumn(interval.startLocal),
          endLocal: localToTimeColumn(interval.endLocal),
          effectiveFrom,
          effectiveTo: null as string | null,
        })),
      );

      if (rows.length > 0) {
        await tx.insert(availabilityRules).values(rows);
      }

      await resealVersions(tx, staffId);
    }
  });

  revalidateHours();

  return {
    ok: true,
    message:
      targetStaffIds.length === 1
        ? "Hours copied to 1 person."
        : `Hours copied to ${targetStaffIds.length} people.`,
  };
}

function revalidateHours(): void {
  revalidatePath("/admin/hours");
  revalidatePath("/admin/time-off");
  revalidatePath("/admin");
}
