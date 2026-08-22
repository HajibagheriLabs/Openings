import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { BookingShell } from "@/components/booking/booking-shell";
import { StepHeading } from "@/components/booking/step-heading";
import { DurationChip } from "@/components/duration-chip";
import { bookingUrl } from "@/lib/booking/url";
import { describeDepositSplit, formatCents } from "@/lib/money";

/**
 * Step 1 — what are you booking.
 *
 * A Server Component, and a list of links. Choosing a service is a NAVIGATION:
 * it changes the URL, the server renders the next step, and this screen ships
 * no JavaScript at all. That is not frugality for its own sake — it is what
 * makes the back button, a refresh and a shared link all behave without a line
 * of code deciding that they should.
 *
 * Only bookable services reach this list, which is stricter than "active".
 * A service nobody active can perform, or one whose length does not fit the
 * booking grid, is filtered out upstream — offering it would send the visitor
 * to a calendar with every day greyed out and no explanation.
 */

export interface BookableService {
  id: string;
  name: string;
  description: string | null;
  durationMin: number;
  priceCents: number;
  depositType: "none" | "flat" | "percent";
  depositValue: number;
}

export function ServiceStep({
  slug,
  currency,
  services,
  step,
  totalSteps,
  header,
}: {
  slug: string;
  currency: string;
  services: BookableService[];
  step: number;
  totalSteps: number;
  header: ReactNode;
}) {
  return (
    <BookingShell step={step} totalSteps={totalSteps} header={header}>
      <section className="flex flex-col gap-5">
        <StepHeading
          eyebrow="Service"
          title="What can we do for you?"
          description="Prices include everything. Pick one to see when it is free."
        />

        <ul className="flex flex-col gap-3">
          {services.map((service) => {
            const deposit = describeDepositSplit(service, currency);

            return (
              <li key={service.id}>
                <Link
                  href={bookingUrl(slug, { service: service.id })}
                  className="flex items-center gap-4 rounded-card border border-line bg-surface p-4 hover:border-line-strong"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-2">
                    <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <span className="type-section text-ink">
                        {service.name}
                      </span>
                      <span className="type-time text-ink">
                        {formatCents(service.priceCents, currency)}
                      </span>
                    </span>

                    {service.description ? (
                      <span className="type-body-sm text-ink-muted">
                        {service.description}
                      </span>
                    ) : null}

                    <span className="flex flex-wrap items-center gap-3">
                      <DurationChip minutes={service.durationMin} />
                      {/* "£15 deposit, £45 on the day" — what leaves the
                          account now and what to bring, never a policy name. */}
                      {deposit ? (
                        <span className="type-body-sm text-ink-muted">
                          {deposit}
                        </span>
                      ) : null}
                    </span>
                  </span>

                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-ink-faint"
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </BookingShell>
  );
}
