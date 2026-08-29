"use server";

import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { appointments, customers } from "@/db/schema";
import { refuseDemoDelete } from "@/server/demo/guard";
import {
  loadCustomerHistory,
  type CustomerVisit,
} from "@/server/queries/customers";
import type { MutationResult } from "@/server/actions/result";

import { requireOwnerBusiness } from "./context";

/**
 * One customer's history, fetched when their row is opened.
 *
 * NOT SENT WITH THE LIST. Two hundred customers with their whole diary
 * attached is a large payload to render forty names, and every appointment in
 * it carries a private note the screen was not asked to show. The list shows
 * counts; the history arrives when somebody presses a row.
 *
 * The business is derived from the session, never taken from an argument — the
 * customer id alone proves nothing, and the query below scopes on both.
 */
export async function readCustomerHistory(
  customerId: string,
): Promise<CustomerVisit[]> {
  const business = await requireOwnerBusiness();

  const parsed = z.uuid().safeParse(customerId);

  if (!parsed.success) {
    return [];
  }

  return loadCustomerHistory(business.id, parsed.data);
}


/* ===========================================================================
   Forgetting a customer
   =========================================================================== */

/**
 * ═══ ERASURE ON REQUEST, WITHOUT DESTROYING THE BUSINESS'S BOOKS ═══
 *
 * A customer writes in and asks to be forgotten. What has to go is everything
 * that identifies them: their name, their address, their phone number, the
 * private note the business keeps about them, the timezone their browser
 * reported, and the note they typed into their own booking form.
 *
 * WHAT DOES NOT GO IS THE APPOINTMENT. Three reasons, and none of them is
 * convenience:
 *
 *   1. THE DATABASE REFUSES. `appointments.customer_id` is ON DELETE RESTRICT,
 *      on purpose — an appointment that lost its customer would violate the
 *      CHECK constraint that says anything past `held` has one.
 *   2. IT IS SOMEBODY ELSE'S RECORD TOO. A completed appointment is the
 *      business's account of a service they performed and money they took.
 *      Erasure does not reach into a third party's financial records, and a
 *      product that silently deleted them would be doing the owner harm in the
 *      name of doing the customer good.
 *   3. THE MONEY TRAIL HAS TO SURVIVE. `stripe_payment_intent_id`,
 *      `deposit_cents` and `refunded_cents` are how a charge is reconciled
 *      months later. Removing them would leave payments in Stripe that nothing
 *      here can explain.
 *
 * So this ANONYMISES rather than deletes: the row stays, the person does not.
 * After it runs, the appointments are still countable and reconcilable and
 * there is nothing left in this database that says who they belonged to.
 *
 * THE EMAIL IS REPLACED, NOT BLANKED. `customers` has a UNIQUE (business_id,
 * email), and a table full of empty strings would collide on the second
 * erasure. The replacement uses the `.invalid` TLD, which RFC 2606 reserves
 * precisely so it can never resolve — nothing can ever be delivered to it by
 * accident.
 *
 * IT IS DELIBERATELY NOT REVERSIBLE and says so on the button.
 */
export async function forgetCustomer(
  customerId: string,
): Promise<MutationResult> {
  const business = await requireOwnerBusiness();

  const parsed = z.uuid().safeParse(customerId);

  if (!parsed.success) {
    return { ok: false, message: "That customer could not be found." };
  }

  /* The demo's scenery has to survive the next visitor. */
  const refused = refuseDemoDelete(business, "customers");

  if (refused) {
    return refused;
  }

  const [existing] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      /* Scoped on the business as well as the id: an id alone proves nothing,
         and this is the one action in the file that writes. */
      and(eq(customers.id, parsed.data), eq(customers.businessId, business.id)),
    )
    .limit(1);

  if (!existing) {
    return { ok: false, message: "That customer could not be found." };
  }

  /**
   * ONE TRANSACTION. Anonymising the person but leaving their note on an
   * appointment, or the reverse, would be a partial erasure that nobody could
   * see had happened — which is worse than not starting.
   */
  await db.transaction(async (tx) => {
    await tx
      .update(customers)
      .set({
        name: "Forgotten customer",
        /* Unique, undeliverable, and obviously deliberate to anyone reading
           the table later. */
        email: `forgotten+${randomUUID()}@invalid`,
        phone: null,
        timezone: null,
        notes: null,
      })
      .where(eq(customers.id, existing.id));

    /* What the CUSTOMER typed about themselves — allergies, access needs, a
       preference. Personal by definition and theirs to withdraw. */
    await tx
      .update(appointments)
      .set({ customerNote: null })
      .where(
        and(
          eq(appointments.customerId, existing.id),
          eq(appointments.businessId, business.id),
        ),
      );

    /* The business's own note ABOUT the customer, on the appointment rather
       than on the person. Same reasoning: it is about an identifiable
       individual, so it goes with them. */
    await tx
      .update(appointments)
      .set({ internalNote: null })
      .where(
        and(
          eq(appointments.customerId, existing.id),
          eq(appointments.businessId, business.id),
          sql`${appointments.internalNote} IS NOT NULL`,
        ),
      );
  });

  /* The list and any open agenda both name customers. */
  revalidatePath("/admin/customers");
  revalidatePath("/admin");
  revalidatePath("/admin/calendar");

  return {
    ok: true,
    message:
      "Forgotten. Their appointments stay in the diary for your records, with " +
      "nothing left that identifies them.",
  };
}
