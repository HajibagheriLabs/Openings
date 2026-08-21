"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { availabilityRules, staff, timeOff } from "@/db/schema";
import type { RibbonColumn, RibbonSegment } from "@/components/ribbon";
import { toTstzRangeLiteral } from "@/lib/scheduling/slot";
import { Temporal } from "@/lib/scheduling/temporal";
import { resolveTimeOffRange } from "@/lib/scheduling/time-off";
import {
  MINUTES_PER_DAY,
  timeColumnToLocal,
  WEEKDAY_NAMES,
} from "@/lib/scheduling/week";
import {
  timeOffSchema,
  type TimeOffFormInput,
} from "@/lib/validation/hours";
import {
  findConflictingAppointments,
  loadTimeOffInWindow,
  type ConflictingAppointment,
} from "@/server/queries/hours";

import { requireOwnerBusiness } from "./context";
import type { MutationResult } from "./result";

/**
 * Blocking out time.
 *
 * THE CONFLICT RULE: A WARNING, NEVER A BLOCK.
 *
 * A closure that overlaps live appointments is a completely legitimate thing
 * to want — the owner is ill, the boiler broke, the shop is shut. Refusing it
 * would leave them with a calendar that disagrees with reality and no way to
 * fix it. But writing it silently would leave real customers holding
 * appointments nobody is going to keep.
 *
 * So the first submit RETURNS the conflicting appointments instead of writing.
 * The owner reads the list, and either backs out or resubmits with
 * `acknowledgeConflicts`. The second submit writes. Nothing is ever blocked
 * out without somebody having seen whose booking it was — and nothing is ever
 * refused because of a conflict either.
 *
 * Time off does NOT cancel the appointments it covers. They stay exactly where
 * they are, still owned by their customer; the closure only stops NEW bookings
 * landing in that range. Cancelling and telling the customer is a separate,
 * deliberate act that belongs with the agenda, not buried in a form.
 */

export interface TimeOffResult {
  ok: boolean;
  message: string;
  field?: "startDate" | "endDate" | "startLocal" | "endLocal" | "staffId";
  /**
   * Present when the write was held back for review. Not an error: the owner
   * is being shown what they are about to sit on top of.
   */
  conflicts?: ConflictingAppointment[];
}

export async function createTimeOff(
  input: TimeOffFormInput,
): Promise<TimeOffResult> {
  const business = await requireOwnerBusiness();

  const parsed = timeOffSchema.safeParse(input);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];

    return {
      ok: false,
      message: issue.message,
      field: issue.path[0] as TimeOffResult["field"],
    };
  }

  const value = parsed.data;

  if (value.staffId) {
    const [member] = await db
      .select({ id: staff.id })
      .from(staff)
      .where(
        and(eq(staff.id, value.staffId), eq(staff.businessId, business.id)),
      )
      .limit(1);

    if (!member) {
      return {
        ok: false,
        field: "staffId",
        message: "That staff member no longer exists. Reload the page.",
      };
    }
  }

  /**
   * Local dates and times to a real instant range, in the BUSINESS's timezone.
   *
   * All-day resolves to local day boundaries, not UTC midnight, and not
   * start-plus-24-hours — see src/lib/scheduling/time-off.ts for why both of
   * those are wrong and how they fail silently.
   */
  const resolved = resolveTimeOffRange(value, business.timezone);

  if (!resolved.ok) {
    return {
      ok: false,
      message: resolved.message,
      field: resolved.error === "end-before-start" ? "endDate" : "startLocal",
    };
  }

  const conflicts = await findConflictingAppointments(
    business.id,
    resolved.value.range,
    value.staffId,
  );

  if (conflicts.length > 0 && !value.acknowledgeConflicts) {
    return {
      ok: false,
      conflicts,
      message:
        conflicts.length === 1
          ? "One appointment already sits inside that time. It stays in the calendar — blocking the time only stops new bookings."
          : `${conflicts.length} appointments already sit inside that time. They stay in the calendar — blocking the time only stops new bookings.`,
    };
  }

  await db.insert(timeOff).values({
    businessId: business.id,
    staffId: value.staffId,
    range: resolved.value.range,
    reason: value.reason || null,
    isAllDay: value.isAllDay,
  });

  revalidateTimeOff();

  return {
    ok: true,
    message:
      conflicts.length > 0
        ? `Time blocked. ${conflicts.length} existing appointment${
            conflicts.length === 1 ? "" : "s"
          } left untouched — open the agenda if you need to move ${
            conflicts.length === 1 ? "it" : "them"
          }.`
        : "Time blocked.",
  };
}

export async function deleteTimeOff(id: string): Promise<MutationResult> {
  const business = await requireOwnerBusiness();

  const [deleted] = await db
    .delete(timeOff)
    .where(and(eq(timeOff.id, id), eq(timeOff.businessId, business.id)))
    .returning({ id: timeOff.id });

  if (!deleted) {
    return { ok: false, message: "That block no longer exists." };
  }

  revalidateTimeOff();

  return { ok: true, message: "Time unblocked. That range is bookable again." };
}

/* ---------------------------------------------------------------------------
   The week preview
--------------------------------------------------------------------------- */

export interface TimeOffPreview {
  window: { startMinute: number; endMinute: number };
  columns: RibbonColumn[];
  /** The Monday of the week being drawn, as an ISO instant, for the heading. */
  weekStartInstant: string;
  /** Local dates of the seven columns, for the headings. */
  dayLabels: string[];
  conflictCount: number;
}

/**
 * What the week will look like once this closure exists.
 *
 * COMPUTED ON THE SERVER, EVERY TIME, ON PURPOSE. Unlike the weekly-hours
 * preview — which draws a pattern of wall-clock minutes and needs no timezone
 * at all — this one is about CONCRETE INSTANTS: where a local day actually
 * begins, how a closure lands across a DST boundary, which real appointments
 * it touches. That is exactly the arithmetic the client is not allowed to do,
 * so the form asks the server on each change and receives minutes and instants
 * back.
 */
export async function previewTimeOffWeek(
  input: TimeOffFormInput,
): Promise<TimeOffPreview | null> {
  const business = await requireOwnerBusiness();

  const parsed = timeOffSchema.safeParse(input);

  if (!parsed.success) {
    return null;
  }

  const value = parsed.data;
  const resolved = resolveTimeOffRange(value, business.timezone);

  if (!resolved.ok) {
    return null;
  }

  const timeZone = business.timezone;

  /**
   * The local week containing the first day of the closure, Monday to Sunday.
   *
   * `dayOfWeek` is 1–7 with Monday as 1 in the ISO calendar, so subtracting
   * `dayOfWeek - 1` days lands on that week's Monday — calendar arithmetic,
   * not a millisecond subtraction that a DST change would knock sideways.
   */
  const firstDay = Temporal.Instant.fromEpochMilliseconds(
    resolved.value.startsAt.getTime(),
  )
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();

  const monday = firstDay.subtract({ days: firstDay.dayOfWeek - 1 });

  const weekStart = monday.toZonedDateTime(timeZone).startOfDay();
  const weekEnd = monday
    .add({ days: 7 })
    .toZonedDateTime(timeZone)
    .startOfDay();

  const weekRange = toTstzRangeLiteral(
    new Date(weekStart.epochMilliseconds),
    new Date(weekEnd.epochMilliseconds),
  );

  /**
   * The hours to draw underneath the closure.
   *
   * For a personal closure, that person's rules. For a BUSINESS-WIDE one, every
   * staff member's — the union, since the question being previewed is "what
   * open time does this close", and open time belongs to whoever has it.
   * Segments from two people who work the same hours draw on top of each other
   * and look like one, which is the correct answer to that question.
   */
  const [rules, closures, conflicts] = await Promise.all([
    db
      .select({
        id: availabilityRules.id,
        weekday: availabilityRules.weekday,
        startLocal: availabilityRules.startLocal,
        endLocal: availabilityRules.endLocal,
        effectiveFrom: availabilityRules.effectiveFrom,
        effectiveTo: availabilityRules.effectiveTo,
      })
      .from(availabilityRules)
      .innerJoin(staff, eq(staff.id, availabilityRules.staffId))
      .where(
        and(
          eq(staff.businessId, business.id),
          eq(staff.isActive, true),
          value.staffId
            ? eq(availabilityRules.staffId, value.staffId)
            : undefined,
        ),
      ),
    loadTimeOffInWindow(business.id, weekRange, value.staffId),
    findConflictingAppointments(
      business.id,
      resolved.value.range,
      value.staffId,
    ),
  ]);

  const columns: RibbonColumn[] = [];
  const dayLabels: string[] = [];

  for (let offset = 0; offset < 7; offset += 1) {
    const date = monday.add({ days: offset });
    const dayStart = date.toZonedDateTime(timeZone).startOfDay();
    const dayEnd = date.add({ days: 1 }).toZonedDateTime(timeZone).startOfDay();

    dayLabels.push(date.toString());

    const segments: RibbonSegment[] = [];

    /**
     * The staff member's open hours for this day, from the version in force
     * ON THAT DATE. A preview that ignored effective dating would show the
     * current pattern on a day a future version already governs.
     */
    const isoWeekday = date.dayOfWeek % 7; // Temporal: Monday=1..Sunday=7 → 1..6,0
    const localDate = date.toString();

    for (const rule of rules) {
      if (rule.weekday !== isoWeekday) {
        continue;
      }
      if (rule.effectiveFrom > localDate) {
        continue;
      }
      if (rule.effectiveTo && rule.effectiveTo < localDate) {
        continue;
      }

      const startMinute = minutesFromTimeColumn(rule.startLocal);
      const endMinute = minutesFromTimeColumn(rule.endLocal);
      const duration =
        endMinute > startMinute
          ? endMinute - startMinute
          : MINUTES_PER_DAY - startMinute + endMinute;

      segments.push({
        id: `rule-${rule.id}-${offset}`,
        state: "open",
        startMinute,
        durationMin: Math.min(duration, MINUTES_PER_DAY - startMinute),
        label: "Open",
      });
    }

    // Existing closures, then the proposed one on top. Both are drawn blocked
    // — the ribbon does not distinguish "already closed" from "about to be",
    // and the list beside it does.
    for (const closure of [
      ...closures.map((row) => ({
        id: row.id,
        startsAt: new Date(row.startsAt),
        endsAt: new Date(row.endsAt),
        label: row.reason ?? "Blocked",
        proposed: false,
      })),
      {
        id: "proposed",
        startsAt: resolved.value.startsAt,
        endsAt: resolved.value.endsAt,
        label: value.reason || "This block",
        proposed: true,
      },
    ]) {
      const piece = clampToDay(closure.startsAt, closure.endsAt, dayStart, dayEnd);

      if (!piece) {
        continue;
      }

      segments.push({
        id: `off-${closure.id}-${offset}`,
        state: "blocked",
        startMinute: piece.startMinute,
        durationMin: piece.durationMin,
        startsAt: piece.startsAt,
        endsAt: piece.endsAt,
        label: closure.label,
      });
    }

    columns.push({
      id: localDate,
      label: WEEKDAY_NAMES[isoWeekday].short,
      sublabel: localDate.slice(5),
      segments,
    });
  }

  const allSegments = columns.flatMap((column) => column.segments);
  const earliest = allSegments.length
    ? Math.min(...allSegments.map((segment) => segment.startMinute))
    : 8 * 60;
  const latest = allSegments.length
    ? Math.max(
        ...allSegments.map(
          (segment) => segment.startMinute + segment.durationMin,
        ),
      )
    : 20 * 60;

  return {
    window: {
      startMinute: Math.max(0, Math.floor((earliest - 30) / 60) * 60),
      endMinute: Math.min(MINUTES_PER_DAY, Math.ceil((latest + 30) / 60) * 60),
    },
    columns,
    weekStartInstant: new Date(weekStart.epochMilliseconds).toISOString(),
    dayLabels,
    conflictCount: conflicts.length,
  };
}

/**
 * The part of a range that falls inside one local day, as minutes since that
 * day's local midnight.
 *
 * Measured against the DAY'S OWN start instant rather than by reading a clock
 * off the timestamp, which is what makes it right on the two days a local day
 * is 23 or 25 hours long: the offset is a real elapsed duration from a real
 * boundary, and the boundary was resolved by the timezone.
 */
function clampToDay(
  startsAt: Date,
  endsAt: Date,
  dayStart: Temporal.ZonedDateTime,
  dayEnd: Temporal.ZonedDateTime,
): {
  startMinute: number;
  durationMin: number;
  startsAt: string;
  endsAt: string;
} | null {
  const dayStartMs = dayStart.epochMilliseconds;
  const dayEndMs = dayEnd.epochMilliseconds;

  const from = Math.max(startsAt.getTime(), dayStartMs);
  const to = Math.min(endsAt.getTime(), dayEndMs);

  if (to <= from) {
    return null;
  }

  return {
    startMinute: Math.round((from - dayStartMs) / 60_000),
    durationMin: Math.round((to - from) / 60_000),
    startsAt: new Date(from).toISOString(),
    endsAt: new Date(to).toISOString(),
  };
}

/** "09:00:00" to 540. Wall-clock minutes, no timezone involved. */
function minutesFromTimeColumn(value: string): number {
  const [hours, minutes] = timeColumnToLocal(value).split(":").map(Number);

  return hours * 60 + minutes;
}

function revalidateTimeOff(): void {
  revalidatePath("/admin/time-off");
  revalidatePath("/admin/hours");
  revalidatePath("/admin");
}
