import { z } from "zod";

import { LOCAL_DATE_PATTERN } from "@/lib/admin/calendar";
import { LOCAL_TIME_PATTERN } from "@/lib/scheduling/week";

/**
 * The two forms the master schedule can write from.
 *
 * Zod at the boundary, as everywhere else — a Server Action is a public HTTP
 * endpoint and the shape of what arrives is never assumed. What these schemas
 * do NOT do is decide anything about time: they check that "2026-08-29" looks
 * like a date and "14:30" looks like a wall-clock time, and the server turns
 * that pair into an instant in the business's zone with Temporal. A regex is
 * not a timezone.
 */

const localDate = z
  .string()
  .regex(LOCAL_DATE_PATTERN, "Pick a date.");

const localTime = z
  .string()
  .regex(LOCAL_TIME_PATTERN, "Write the time as HH:MM, for example 14:30.");

/* ===========================================================================
   Manual booking
   =========================================================================== */

export const manualBookingSchema = z.object({
  serviceId: z.uuid("Pick a service."),
  staffId: z.uuid("Pick who is doing it."),
  /** Local calendar date in the business's timezone. */
  date: localDate,
  /** Local wall-clock start. Resolved to an instant on the server. */
  startLocal: localTime,

  customerName: z
    .string()
    .trim()
    .min(1, "Write down who this is for.")
    .max(120, "That name is too long."),
  /**
   * REQUIRED, and this is a real product decision rather than an oversight.
   *
   * An appointment with no address cannot be confirmed to anybody, cannot carry
   * a manage link, and cannot be reminded — so the booking would exist for the
   * business and not for the customer, which is the failure mode this product
   * is built to avoid. An owner who genuinely has no address for a walk-in
   * wants BLOCKED TIME, not a booking: it holds the slot, it says why, and it
   * promises the customer nothing the product cannot deliver. The form says so
   * next to this field.
   */
  customerEmail: z.email("Write a real email address, or block the time instead."),
  customerPhone: z
    .string()
    .trim()
    .max(40, "That phone number is too long.")
    .optional()
    .transform((value) => value || null),

  customerNote: z
    .string()
    .trim()
    .max(1000, "That note is too long.")
    .optional()
    .transform((value) => value || null),
  internalNote: z
    .string()
    .trim()
    .max(1000, "That note is too long.")
    .optional()
    .transform((value) => value || null),

  /**
   * Ignore lead time, opening hours, closures and the booking horizon.
   *
   * IT DOES NOT — AND CANNOT — IGNORE THE OVERLAP CONSTRAINT. See the note on
   * `createManualBooking`.
   */
  override: z.boolean().default(false),
  notifyCustomer: z.boolean().default(true),
});

export type ManualBookingInput = z.input<typeof manualBookingSchema>;
export type ManualBookingValues = z.output<typeof manualBookingSchema>;

/* ===========================================================================
   Blocking time from the agenda
   =========================================================================== */

/**
 * A block created by dragging on the ribbon, or typed into the same form.
 *
 * Deliberately NOT `timeOffSchema` from ./hours.ts. That one is the full
 * closure form — a range of days, all-day, a person or the whole business — and
 * it is the right shape for planning a holiday. This is the shape of the
 * gesture: one day, one start, one end, on one lane, made in two seconds while
 * looking at the day it applies to. They write to the same table.
 */
export const blockTimeSchema = z
  .object({
    /** Null blocks the whole business, matching `time_off.staff_id`. */
    staffId: z.uuid().nullable().default(null),
    date: localDate,
    startLocal: localTime,
    endLocal: localTime,
    reason: z
      .string()
      .trim()
      .max(120, "Keep the reason short.")
      .optional()
      .transform((value) => value || null),
  })
  .refine((value) => value.endLocal > value.startLocal, {
    /**
     * Same-day only, so a plain string comparison is exact for "HH:MM" and a
     * block that crosses midnight is refused rather than silently inverted.
     * Somebody closing overnight wants the time-off screen, which handles
     * multi-day ranges properly.
     */
    message: "The end has to come after the start.",
    path: ["endLocal"],
  });

export type BlockTimeInput = z.input<typeof blockTimeSchema>;
export type BlockTimeValues = z.output<typeof blockTimeSchema>;

/* ===========================================================================
   Small edits from the detail sheet
   =========================================================================== */

export const internalNoteSchema = z.object({
  appointmentId: z.uuid(),
  note: z
    .string()
    .trim()
    .max(2000, "That note is too long.")
    .transform((value) => value || null),
});

export const cancelAppointmentSchema = z.object({
  appointmentId: z.uuid(),
  reason: z
    .string()
    .trim()
    .max(500, "Keep the reason short.")
    .optional()
    .transform((value) => value || null),
});

export const settleAppointmentSchema = z.object({
  appointmentId: z.uuid(),
  outcome: z.enum(["completed", "no_show"]),
});
