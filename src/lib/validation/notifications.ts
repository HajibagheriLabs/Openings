import { z } from "zod";

import {
  MAX_REMINDER_LEAD_MIN,
  MIN_REMINDER_LEAD_MIN,
} from "@/lib/notifications/reminder";

/**
 * The one notification setting an owner can change.
 *
 * Shared by the form and the action, so the browser and the server cannot
 * disagree about what a valid lead time is. No `server-only` — that sharing is
 * the point.
 */

export const reminderSettingsSchema = z.object({
  reminderLeadMin: z.coerce
    .number()
    .int("Choose one of the offered times.")
    .min(
      MIN_REMINDER_LEAD_MIN,
      "A reminder closer than 15 minutes competes with the appointment itself.",
    )
    .max(
      MAX_REMINDER_LEAD_MIN,
      "More than a week ahead is not a reminder, it is a second confirmation.",
    ),
});

export type ReminderSettingsInput = z.input<typeof reminderSettingsSchema>;
export type ReminderSettings = z.output<typeof reminderSettingsSchema>;
export type ReminderSettingsField = keyof ReminderSettings;

/**
 * The offered lead times.
 *
 * A LIST, NOT A FREE NUMBER. "How long before?" has perhaps eight sensible
 * answers and a text box invites all the others — 1440 typed as 144, or a
 * value in hours into a field that means minutes. The list is the validation
 * that a person never has to read.
 */
export const REMINDER_LEAD_OPTIONS = [
  { minutes: 30, label: "30 minutes before" },
  { minutes: 60, label: "An hour before" },
  { minutes: 2 * 60, label: "2 hours before" },
  { minutes: 3 * 60, label: "3 hours before" },
  { minutes: 6 * 60, label: "6 hours before" },
  { minutes: 12 * 60, label: "12 hours before" },
  { minutes: 24 * 60, label: "A day before" },
  { minutes: 48 * 60, label: "2 days before" },
  { minutes: 72 * 60, label: "3 days before" },
  { minutes: 7 * 24 * 60, label: "A week before" },
] as const;
