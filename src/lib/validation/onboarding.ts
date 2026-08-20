import { z } from "zod";

import { CURRENCIES, parseMoneyToCents } from "@/lib/money";
import {
  RESERVED_SLUGS,
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  SLUG_PATTERN,
} from "@/lib/slug";

/**
 * The onboarding contract, shared by the wizard and the Server Action.
 *
 * One schema, two boundaries. The client parses it to show a message beside
 * the field; the server parses the same thing again because a Server Action is
 * a public HTTP endpoint and anything the browser did is a suggestion.
 *
 * No `server-only` import here on purpose — this file is meant to be shared.
 */

/** "HH:MM", 24-hour, as an `<input type="time">` produces. */
const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Every IANA zone this runtime knows about.
 *
 * Validating against the real list rather than a regex is what stops
 * "Europe/Berlyn" from reaching the database. A bad timezone there does not
 * fail loudly — it quietly shifts every appointment the business ever takes.
 */
export const SUPPORTED_TIMEZONES: readonly string[] =
  Intl.supportedValuesOf("timeZone");

const timezoneSchema = z
  .string()
  .refine((value) => SUPPORTED_TIMEZONES.includes(value), {
    message: "Choose a timezone from the list.",
  });

export const WEEKDAYS = [
  { weekday: 0, label: "Sunday", short: "Sun" },
  { weekday: 1, label: "Monday", short: "Mon" },
  { weekday: 2, label: "Tuesday", short: "Tue" },
  { weekday: 3, label: "Wednesday", short: "Wed" },
  { weekday: 4, label: "Thursday", short: "Thu" },
  { weekday: 5, label: "Friday", short: "Fri" },
  { weekday: 6, label: "Saturday", short: "Sat" },
] as const;

/* ---------------------------------------------------------------------------
   Step 1 — the business
--------------------------------------------------------------------------- */

export const businessStepSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Give the business a name.")
    .max(80, "That name is too long."),

  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(SLUG_MIN_LENGTH, `At least ${SLUG_MIN_LENGTH} characters.`)
    .max(SLUG_MAX_LENGTH, `At most ${SLUG_MAX_LENGTH} characters.`)
    .regex(
      SLUG_PATTERN,
      "Lowercase letters, numbers and single hyphens only.",
    )
    .refine((value) => !RESERVED_SLUGS.has(value), {
      message: "That address is reserved. Pick another.",
    }),

  timezone: timezoneSchema,

  /**
   * The owner has to tick this. Everything in the product — opening hours,
   * lead time, the ribbon, the reminder that fires the evening before — is
   * resolved in this zone on the server. Getting it wrong does not throw; it
   * silently offers the wrong hours to every customer.
   */
  timezoneConfirmed: z.literal(true, {
    message: "Confirm the timezone before continuing.",
  }),
});

/* ---------------------------------------------------------------------------
   Step 2 — opening hours
--------------------------------------------------------------------------- */

/**
 * PLAIN LOCAL WALL-CLOCK TIMES, not instants. "We open at 9" is a fact about
 * the clock on the wall and has to survive a DST change; an instant does not.
 * These land in `availability_rules.start_local` / `end_local` unchanged, and
 * the server expands them per day, in the business timezone.
 */
export const openingHoursDaySchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    isOpen: z.boolean(),
    startLocal: z.string().regex(LOCAL_TIME_PATTERN, "Use HH:MM."),
    endLocal: z.string().regex(LOCAL_TIME_PATTERN, "Use HH:MM."),
  })
  .refine((day) => !day.isOpen || day.endLocal > day.startLocal, {
    /**
     * A shift that crosses midnight is legal in the schema (end < start) but
     * not offered here — it needs its own explanation, and onboarding has two
     * minutes. It can be added afterwards in the hours settings.
     */
    message: "Closing time has to be after opening time.",
    path: ["endLocal"],
  });

export const openingHoursSchema = z
  .array(openingHoursDaySchema)
  .length(7, "Every weekday needs a row.")
  .refine((days) => days.some((day) => day.isOpen), {
    message: "Open on at least one day, or nobody can book.",
  })
  .refine(
    (days) => new Set(days.map((day) => day.weekday)).size === 7,
    { message: "Each weekday may appear once." },
  );

/* ---------------------------------------------------------------------------
   Step 3 — the first service
--------------------------------------------------------------------------- */

const currencySchema = z.enum(
  CURRENCIES.map((currency) => currency.code) as [string, ...string[]],
);

export const serviceStepSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, "Give the service a name.")
      .max(80, "That name is too long."),

    durationMin: z
      .number()
      .int()
      .min(5, "Five minutes is the shortest bookable service.")
      .max(600, "Ten hours is the longest a single service can run."),

    currency: currencySchema,

    /**
     * Typed as a person types it — "45", "45.00", "45,50". Converted to cents
     * here, once, without ever becoming a float.
     */
    price: z.string().trim(),

    depositType: z.enum(["none", "flat", "percent"]),

    /** Cents when flat, whole percent when percent, ignored when none. */
    deposit: z.string().trim().default("0"),
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

/* ---------------------------------------------------------------------------
   The whole wizard
--------------------------------------------------------------------------- */

export const onboardingSchema = z.object({
  business: businessStepSchema,
  hours: openingHoursSchema,
  service: serviceStepSchema,
});

export type BusinessStepInput = z.input<typeof businessStepSchema>;
export type OpeningHoursInput = z.input<typeof openingHoursSchema>;
export type OpeningHoursDayInput = z.input<typeof openingHoursDaySchema>;
export type ServiceStepInput = z.input<typeof serviceStepSchema>;
export type OnboardingInput = z.input<typeof onboardingSchema>;

/** Mon–Fri, nine to five. The most common answer, already filled in. */
export const DEFAULT_OPENING_HOURS: OpeningHoursDayInput[] = WEEKDAYS.map(
  ({ weekday }) => ({
    weekday,
    isOpen: weekday >= 1 && weekday <= 5,
    startLocal: "09:00",
    endLocal: "17:00",
  }),
);
