"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { businesses } from "@/db/schema";
import { describeReminderLead } from "@/lib/notifications/reminder";
import {
  reminderSettingsSchema,
  type ReminderSettingsField,
  type ReminderSettingsInput,
} from "@/lib/validation/notifications";

import { requireOwnerBusiness } from "./context";
import type { MutationResult } from "./result";

/**
 * How long before an appointment the reminder goes out.
 *
 * ═══ IT ONLY AFFECTS BOOKINGS MADE FROM NOW ON, AND THAT IS DELIBERATE ═══
 *
 * A reminder is queued when a booking is confirmed and, when a delivery
 * service is configured, a message is published for that exact instant then
 * and there. Changing this setting does NOT go back and move them.
 *
 * The alternative — rewriting every pending reminder and re-publishing every
 * scheduled message — would mean one form submit fanning out into hundreds of
 * third-party calls, any of which can fail halfway and leave the outbox and
 * the delivery service disagreeing about when a message is due. For a setting
 * an owner changes roughly never, that is a great deal of machinery to get
 * wrong in exchange for moving some reminders by a few hours.
 *
 * So the rule is stated on the form instead: new bookings use the new timing.
 */
export async function updateReminderSettings(
  input: ReminderSettingsInput,
): Promise<MutationResult<ReminderSettingsField>> {
  const business = await requireOwnerBusiness();

  const parsed = reminderSettingsSchema.safeParse(input);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];

    return {
      ok: false,
      message: issue?.message ?? "That is not a reminder time we can use.",
      fieldErrors: { reminderLeadMin: issue?.message },
    };
  }

  await db
    .update(businesses)
    .set({ reminderLeadMin: parsed.data.reminderLeadMin })
    /* Matched on the owned id, never on one from the arguments. */
    .where(eq(businesses.id, business.id));

  revalidatePath("/admin/settings");

  return {
    ok: true,
    message: `Reminders now go out ${describeReminderLead(
      parsed.data.reminderLeadMin,
    )}.`,
  };
}
