import type { Metadata } from "next";

import { CustomersManager } from "@/components/admin/customers/customers-manager";
import {
  getOwnedBusiness,
  requireBusinessAccess,
  requireUser,
} from "@/lib/auth-server";
import { loadCustomers } from "@/server/queries/customers";

export const metadata: Metadata = {
  title: "Customers",
};

/**
 * The customer book.
 *
 * The search is a query parameter and the filtering happens in Postgres, so a
 * business with four thousand customers sends four rows to show four rows. See
 * the note on `CustomersManager` for why that is in the URL rather than in
 * component state.
 */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requireUser("/admin/customers");
  const owned = await getOwnedBusiness(user.id);

  /* Re-resolved through the gate every owner route uses, rather than trusted
     from the layout. */
  const { business } = await requireBusinessAccess(owned!.id);

  const { q } = await searchParams;
  const query = q?.trim() ?? "";

  const customers = await loadCustomers(business.id, query || null);

  return (
    <CustomersManager
      /* Deliberately NOT keyed on the query. Remounting on every keystroke's
         navigation would take focus out of the search box the owner is still
         typing into; the component reconciles its own box against the URL
         instead. */
      customers={customers}
      query={query}
      currency={business.currency}
      timeZone={business.timezone}
      businessName={business.name}
    />
  );
}
