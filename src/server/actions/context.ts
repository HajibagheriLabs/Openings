import "server-only";

import { redirect } from "next/navigation";

import type { Business } from "@/db/schema";
import {
  getOwnedBusiness,
  requireBusinessAccess,
  requireUser,
} from "@/lib/auth-server";

/**
 * The business the caller owns, resolved from the session and nothing else.
 *
 * Every mutation in the owner area starts here. NO ACTION TAKES A BUSINESS ID
 * FROM ITS ARGUMENTS — a Server Action is a public HTTP endpoint, and an
 * action that accepted `businessId` would be one forged request away from
 * letting anybody rename someone else's services. The id is derived, so there
 * is nothing to forge.
 *
 * Every row an action then touches is still matched on `business_id` in its
 * WHERE clause, so a stolen service id from another tenant updates zero rows
 * rather than the wrong one.
 */
export async function requireOwnerBusiness(): Promise<Business> {
  const user = await requireUser();
  const owned = await getOwnedBusiness(user.id);

  if (!owned) {
    redirect("/onboarding");
  }

  // Re-resolved through the same gate every owner route uses, so ownership is
  // part of the lookup rather than a check that could be skipped.
  const { business } = await requireBusinessAccess(owned.id);

  return business;
}
