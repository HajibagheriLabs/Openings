"use client";

import { Mail, Phone } from "lucide-react";
import { useEffect, useState } from "react";

import { Sheet } from "@/components/sheet";
import { SkeletonText } from "@/components/skeleton";
import { AppointmentStatusBadge } from "@/components/status-badge";
import {
  formatInstantDate,
  formatInstantRange,
} from "@/components/time-text";
import { formatCents } from "@/lib/money";
import { readCustomerHistory } from "@/server/actions/customers";
import type { CustomerRow, CustomerVisit } from "@/server/queries/customers";

/**
 * One customer: how to reach them, and everything they have booked.
 *
 * The counts come from the list row, which already has them. The HISTORY is
 * fetched when the sheet opens — see `readCustomerHistory` for why it is not
 * sent with the list.
 *
 * The email link is a `mailto:` with their address in it and nothing else
 * filled in, which is the difference from the appointment sheet's version: that
 * one is about a specific booking and can say which, this one is about a person
 * and has nothing to assume.
 */
export function CustomerSheet({
  customer,
  open,
  onOpenChange,
  currency,
  timeZone,
  businessName,
}: {
  customer: CustomerRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currency: string;
  timeZone: string;
  businessName: string;
}) {
  /**
   * The history, tagged with WHOSE it is.
   *
   * Derived rather than cleared, so "one person's history under another
   * person's name" is not a state this component can be in even for a frame:
   * opening somebody else simply stops the id matching, and the skeleton is on
   * screen until the right answer lands.
   */
  const [loaded, setLoaded] = useState<{
    id: string;
    visits: CustomerVisit[];
  } | null>(null);

  const history =
    loaded && customer && loaded.id === customer.id ? loaded.visits : null;

  useEffect(() => {
    if (!open || !customer) {
      return;
    }

    let cancelled = false;
    const { id } = customer;

    void readCustomerHistory(id).then((visits) => {
      if (!cancelled) {
        setLoaded({ id, visits });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [customer, open]);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side="right"
      title={customer?.name ?? "Customer"}
      description={
        customer
          ? `First booked ${formatInstantDate(customer.createdAt, timeZone)}`
          : undefined
      }
    >
      {!customer ? null : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <a
              href={`mailto:${encodeURIComponent(
                customer.email,
              )}?subject=${encodeURIComponent(businessName)}`}
              className="type-body-sm flex items-center gap-2 text-accent underline-offset-4 hover:underline"
            >
              <Mail aria-hidden="true" className="size-4" />
              {customer.email}
            </a>

            {customer.phone ? (
              <a
                href={`tel:${customer.phone.replace(/\s/g, "")}`}
                className="type-body-sm flex items-center gap-2 text-accent underline-offset-4 hover:underline"
              >
                <Phone aria-hidden="true" className="size-4" />
                {customer.phone}
              </a>
            ) : null}
          </div>

          <dl className="grid grid-cols-3 gap-4 border-y border-line py-4">
            <Figure label="Visits" value={String(customer.visits)} />
            <Figure label="No-shows" value={String(customer.noShows)} />
            <Figure
              label="Spend"
              value={formatCents(customer.spendCents, currency)}
            />
          </dl>

          <section className="flex flex-col gap-3">
            <h3 className="type-label">History</h3>

            {history === null ? (
              <SkeletonText lines={4} />
            ) : history.length === 0 ? (
              <p className="type-body-sm text-ink-muted">
                Nothing booked yet. This record exists because they started a
                booking or you added them by hand.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {history.map((visit) => (
                  <li key={visit.id} className="flex flex-col gap-1 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="type-time text-ink">
                        {formatInstantDate(visit.startsAt, timeZone)}
                      </span>
                      <AppointmentStatusBadge status={visit.status} />
                    </div>

                    <span className="type-body-sm text-ink-muted">
                      {formatInstantRange(
                        visit.startsAt,
                        visit.endsAt,
                        timeZone,
                      )}{" "}
                      · {visit.serviceName} · {visit.staffName}
                    </span>

                    <span className="type-body-sm text-ink-faint">
                      {formatCents(visit.priceCents, currency)}
                      {visit.depositCents > 0
                        ? ` · ${formatCents(
                            visit.depositCents,
                            currency,
                          )} deposit`
                        : null}
                    </span>

                    {visit.internalNote ? (
                      <span className="type-body-sm text-ink-muted">
                        {visit.internalNote}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Sheet>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="type-label">{label}</dt>
      <dd className="type-time-lg text-ink">{value}</dd>
    </div>
  );
}
