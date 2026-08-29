"use client";

import { Contact, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { PillButton } from "@/components/pill-button";
import { StatusBadge } from "@/components/status-badge";
import { formatInstantDate } from "@/components/time-text";
import { Input } from "@/components/ui/input";
import { formatCents } from "@/lib/money";
import type { CustomerRow } from "@/server/queries/customers";

import { CustomerSheet } from "./customer-sheet";

/**
 * Everyone who has booked.
 *
 * ═══ THE SEARCH IS IN THE URL ═══
 *
 * It is a Server Component query behind a `?q=`, debounced into
 * `router.replace`, not a client-side filter over a preloaded array. Two
 * reasons: a business with four thousand customers must not send four thousand
 * rows to filter three of them, and a search that lives in the URL can be
 * shared, bookmarked and gone back to.
 *
 * `replace` rather than `push`, so typing six characters does not put six
 * entries in the back stack.
 */
export function CustomersManager({
  customers,
  query,
  currency,
  timeZone,
  businessName,
}: {
  customers: CustomerRow[];
  query: string;
  currency: string;
  timeZone: string;
  businessName: string;
}) {
  const router = useRouter();
  const [term, setTerm] = useState(query);

  /**
   * Empty the search, both halves of it.
   *
   * The box the owner is looking at is component state and the results are a
   * URL. Clearing one without the other leaves the screen contradicting
   * itself, so this does both and skips the debounce — a press of a button is
   * not a keystroke to wait out.
   */
  function clearSearch() {
    setTerm("");
    router.replace("/admin/customers", { scroll: false });
  }
  const [selected, setSelected] = useState<CustomerRow | null>(null);

  useEffect(() => {
    /* Nothing to do while the box already agrees with the URL — which is the
       case on first render and after every navigation this effect causes. */
    if (term === query) {
      return;
    }

    const timer = setTimeout(() => {
      const search = term.trim()
        ? `/admin/customers?q=${encodeURIComponent(term.trim())}`
        : "/admin/customers";

      router.replace(search, { scroll: false });
    }, 250);

    return () => clearTimeout(timer);
  }, [term, query, router]);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Customers"
        title="Customers"
        description="Everyone who has booked. They never get an account — they book as guests and manage the appointment through a signed link."
      />

      <div className="relative max-w-md">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-ink-faint"
        />
        <Input
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Search by name, email or phone"
          aria-label="Search customers"
          className="pl-11"
        />
      </div>

      {customers.length === 0 ? (
        <EmptyState
          icon={Contact}
          title={query ? `Nobody matches “${query}”` : "No customers yet"}
          description={
            query
              ? "Try part of a name, an email address, or the phone number they gave."
              : "Customers appear here the first time somebody books, or the first time you add a booking by hand."
          }
          action={
            query ? (
              /* Clearing the box IS the action, and it has to clear both — the
                 field the owner is looking at and the query in the URL that
                 produced this screen. */
              <PillButton variant="secondary" onClick={clearSearch}>
                Clear the search
              </PillButton>
            ) : (
              <PillButton asChild>
                <Link href="/admin/calendar">Add a booking</Link>
              </PillButton>
            )
          }
        />
      ) : (
        <Card className="overflow-hidden">
          {/* Scrolls inside its own container rather than pushing the page
              sideways on a phone. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] border-collapse">
              <thead>
                <tr className="border-b border-line">
                  <Th>Name</Th>
                  <Th>Last seen</Th>
                  <Th>Next</Th>
                  <Th align="right">Visits</Th>
                  <Th align="right">No-shows</Th>
                  <Th align="right">Spend</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {customers.map((customer) => (
                  <tr
                    key={customer.id}
                    className="cursor-pointer transition-colors hover:bg-surface-sunk"
                    onClick={() => setSelected(customer)}
                  >
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        className="flex flex-col items-start text-left"
                        onClick={(event) => {
                          /* The row is the target; this keeps the row's own
                             handler from firing a second time. */
                          event.stopPropagation();
                          setSelected(customer);
                        }}
                      >
                        <span className="type-section text-ink">
                          {customer.name}
                        </span>
                        <span className="type-body-sm text-ink-muted">
                          {customer.email}
                        </span>
                      </button>
                    </td>

                    <td className="type-body-sm px-4 py-3 text-ink-muted">
                      {customer.lastVisitAt
                        ? formatInstantDate(customer.lastVisitAt, timeZone)
                        : "—"}
                    </td>

                    <td className="type-body-sm px-4 py-3 text-ink-muted">
                      {customer.nextVisitAt
                        ? formatInstantDate(customer.nextVisitAt, timeZone)
                        : "—"}
                    </td>

                    <td className="type-time px-4 py-3 text-right text-ink">
                      {customer.visits}
                    </td>

                    <td className="px-4 py-3 text-right">
                      {customer.noShows > 0 ? (
                        /* The one number worth a badge: it is the fact that
                           changes how a business treats the next booking. */
                        <StatusBadge tone="cancelled">
                          {customer.noShows}
                        </StatusBadge>
                      ) : (
                        <span className="type-time text-ink-faint">0</span>
                      )}
                    </td>

                    <td className="type-time px-4 py-3 text-right text-ink">
                      {formatCents(customer.spendCents, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="type-body-sm max-w-[60ch] text-ink-faint">
        Spend counts appointments you have marked as done. A booking that has
        not happened yet is not money earned, and a no-show never was.
      </p>

      <CustomerSheet
        customer={selected}
        open={selected !== null}
        onOpenChange={(next) => !next && setSelected(null)}
        currency={currency}
        timeZone={timeZone}
        businessName={businessName}
      />
    </div>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      scope="col"
      className={`type-label px-4 py-3 ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}
