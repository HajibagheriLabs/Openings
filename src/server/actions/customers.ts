"use server";

import { z } from "zod";

import {
  loadCustomerHistory,
  type CustomerVisit,
} from "@/server/queries/customers";

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
