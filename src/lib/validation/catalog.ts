import { z } from "zod";

import { parseMoneyToCents } from "@/lib/money";

/**
 * The service and staff contracts, shared by the admin forms and the Server
 * Actions behind them.
 *
 * Same arrangement as onboarding: the client parses to put a message beside a
 * field, the server parses the identical schema again because a Server Action
 * is a public HTTP endpoint and whatever the browser did is a suggestion.
 *
 * No `server-only` import — this file is meant to be shared.
 */

/** Ten hours. Longer than this is a project, not an appointment. */
export const SERVICE_MAX_DURATION_MIN = 600;
/** Four hours of buffer around one appointment is already absurd. */
export const SERVICE_MAX_BUFFER_MIN = 240;
export const INITIALS_MAX_LENGTH = 3;

const uuid = z.uuid("Unknown record.");

/* ---------------------------------------------------------------------------
   Services
--------------------------------------------------------------------------- */

/**
 * Built per business, because the duration rule depends on that business's
 * `slot_granularity_min`.
 *
 * A duration has to be a whole number of booking intervals. The picker offers
 * start times on the grid, so a 50-minute service on a 15-minute grid can only
 * ever start at :00, :15, :30 or :45 and always ends 10 minutes before the
 * next one could start. Every booking would strand an unsellable sliver, and
 * the day would fill at two thirds of its real capacity. Refusing it here is
 * cheaper than explaining it later.
 */
export function buildServiceFormSchema(slotGranularityMin: number) {
  const granularity = Math.max(1, slotGranularityMin);

  return z
    .object({
      /** Present when editing, absent when creating. */
      id: uuid.optional(),

      name: z
        .string()
        .trim()
        .min(2, "Give the service a name.")
        .max(80, "That name is too long."),

      description: z
        .string()
        .trim()
        .max(400, "Keep the description under 400 characters.")
        .default(""),

      durationMin: z
        .number()
        .int("Whole minutes only.")
        .positive("A service has to last longer than zero minutes.")
        .max(
          SERVICE_MAX_DURATION_MIN,
          `${SERVICE_MAX_DURATION_MIN / 60} hours is the longest a single service can run.`,
        )
        .refine((minutes) => minutes % granularity === 0, {
          message: `Use a multiple of ${granularity} minutes — that is this business's booking interval.`,
        }),

      bufferBeforeMin: z
        .number()
        .int("Whole minutes only.")
        .min(0, "A buffer cannot be negative.")
        .max(SERVICE_MAX_BUFFER_MIN, `At most ${SERVICE_MAX_BUFFER_MIN} minutes.`),

      bufferAfterMin: z
        .number()
        .int("Whole minutes only.")
        .min(0, "A buffer cannot be negative.")
        .max(SERVICE_MAX_BUFFER_MIN, `At most ${SERVICE_MAX_BUFFER_MIN} minutes.`),

      /** As a person types it — "45", "45.00", "45,50". Cents on the server. */
      price: z.string().trim(),

      depositType: z.enum(["none", "flat", "percent"]),

      /** Amount when flat, whole percent when percent, ignored when none. */
      deposit: z.string().trim().default("0"),

      /**
       * Who can perform it. May be empty — an unassigned service is legal to
       * SAVE and simply not bookable, which is flagged in the list. Refusing
       * the save would strand an owner who is setting up the service before
       * the person who will do it exists.
       */
      staffIds: z.array(uuid).default([]),

      isActive: z.boolean(),
    })
    .superRefine((service, ctx) => {
      const priceCents = parseMoneyToCents(service.price);

      if (priceCents === null) {
        ctx.addIssue({
          code: "custom",
          path: ["price"],
          message: "Write the price as a number, for example 45 or 45.00.",
        });
        return;
      }

      if (service.depositType === "flat") {
        const depositCents = parseMoneyToCents(service.deposit);

        if (depositCents === null) {
          ctx.addIssue({
            code: "custom",
            path: ["deposit"],
            message: "Write the deposit as a number.",
          });
        } else if (depositCents > priceCents) {
          ctx.addIssue({
            code: "custom",
            path: ["deposit"],
            message: "The deposit cannot be more than the price.",
          });
        }
      }

      if (service.depositType === "percent") {
        const percent = Number(service.deposit);

        if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
          ctx.addIssue({
            code: "custom",
            path: ["deposit"],
            message: "Use a whole percentage between 1 and 100.",
          });
        }
      }
    });
}

export type ServiceFormInput = z.input<ReturnType<typeof buildServiceFormSchema>>;
export type ServiceFormOutput = z.output<
  ReturnType<typeof buildServiceFormSchema>
>;

/* ---------------------------------------------------------------------------
   Staff
--------------------------------------------------------------------------- */

export const staffFormSchema = z.object({
  id: uuid.optional(),

  name: z
    .string()
    .trim()
    .min(2, "Give this person a name.")
    .max(80, "That name is too long."),

  /**
   * Optional, and empty means empty rather than "". Staff email is for the
   * business's own records and for future per-staff notifications; nobody
   * signs in with it, because only owners have accounts.
   */
  email: z
    .string()
    .trim()
    .max(160, "That address is too long.")
    .refine(
      (value) => value === "" || z.email().safeParse(value).success,
      { message: "Write a complete email address, or leave it empty." },
    )
    .default(""),

  /**
   * One to three characters, and they are drawn on booked ribbon segments —
   * the only thing telling one person's carved-out block from another's, since
   * hue is not allowed to carry meaning there. Auto-derived from the name and
   * then editable, because two colleagues can genuinely collapse to the same
   * two letters and only the owner knows what to do about it.
   */
  initials: z
    .string()
    .trim()
    .toUpperCase()
    .min(1, "At least one character.")
    .max(INITIALS_MAX_LENGTH, `At most ${INITIALS_MAX_LENGTH} characters.`)
    .regex(/^[\p{L}\p{N}]+$/u, "Letters and numbers only."),

  serviceIds: z.array(uuid).default([]),

  isActive: z.boolean(),
});

export type StaffFormInput = z.input<typeof staffFormSchema>;
export type StaffFormOutput = z.output<typeof staffFormSchema>;

/* ---------------------------------------------------------------------------
   Reordering
--------------------------------------------------------------------------- */

/**
 * A complete, duplicate-free ordering.
 *
 * The action checks the set matches the business's rows exactly. A partial
 * list would renumber some rows and leave others on stale positions, which is
 * how a list silently ends up with two things claiming position 3.
 */
export const reorderSchema = z
  .array(uuid)
  .min(1, "Nothing to reorder.")
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "That ordering repeats an entry.",
  });
