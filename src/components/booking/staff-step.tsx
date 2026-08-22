import { Check, ChevronRight, Users } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { BookingShell } from "@/components/booking/booking-shell";
import { StepHeading } from "@/components/booking/step-heading";
import { PillButton } from "@/components/pill-button";
import { ANY_STAFF, bookingUrl } from "@/lib/booking/url";
import { cn } from "@/lib/utils";

/**
 * Step 2 — who with.
 *
 * "ANYONE AVAILABLE" IS FIRST AND IT IS THE DEFAULT. Most people booking a
 * haircut do not have a preference; they have a Thursday. Making them choose a
 * stylist before they can see a single time is a step that exists for the
 * business's convenience, so the default is pre-selected — marked as chosen,
 * and repeated as the primary action in the sticky bar — and naming a person
 * is the deliberate act.
 *
 * Choosing anyone rather than a person is not a smaller booking: the
 * availability query takes `any` and returns the union of everybody free, so
 * it always offers at least as many times as any single person would.
 *
 * The step does not exist at all when one person qualifies. A screen with one
 * name on it asks nothing.
 */

export interface BookableStaff {
  id: string;
  name: string;
  initials: string;
}

export function StaffStep({
  slug,
  serviceId,
  staff,
  step,
  totalSteps,
  header,
  choices,
}: {
  slug: string;
  serviceId: string;
  /** Qualified and active, in the business's display order. */
  staff: BookableStaff[];
  step: number;
  totalSteps: number;
  header: ReactNode;
  choices: ReactNode;
}) {
  const anyoneHref = bookingUrl(slug, {
    service: serviceId,
    staff: ANY_STAFF,
  });

  return (
    <BookingShell
      step={step}
      totalSteps={totalSteps}
      header={header}
      choices={choices}
      summary={
        <PillButton asChild block>
          <Link href={anyoneHref}>Continue with anyone available</Link>
        </PillButton>
      }
    >
      <section className="flex flex-col gap-5">
        <StepHeading
          eyebrow="Who"
          title="Anyone in particular?"
          description="Leaving it open finds you the earliest time across the whole team."
        />

        <ul className="flex flex-col gap-3">
          <li>
            <Link
              href={anyoneHref}
              className={cn(
                "flex items-center gap-4 rounded-card p-4",
                // The pre-selected option carries the same encoding an open
                // slot does: accent wash under a 1px accent border.
                "border border-accent bg-accent-wash hover:bg-accent/15",
              )}
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-pill border border-accent bg-surface text-accent">
                <Users aria-hidden="true" className="size-4" />
              </span>

              <span className="flex min-w-0 flex-1 flex-col">
                <span className="type-section text-ink">Anyone available</span>
                <span className="type-body-sm text-ink-muted">
                  The earliest time with any of the team
                </span>
              </span>

              <Check aria-hidden="true" className="size-4 shrink-0 text-accent" />
              <span className="sr-only">Selected by default</span>
            </Link>
          </li>

          {staff.map((member) => (
            <li key={member.id}>
              <Link
                href={bookingUrl(slug, {
                  service: serviceId,
                  staff: member.id,
                })}
                className="flex items-center gap-4 rounded-card border border-line bg-surface p-4 hover:border-line-strong"
              >
                <span className="type-time flex size-10 shrink-0 items-center justify-center rounded-pill border border-line bg-surface-sunk text-ink-muted">
                  {member.initials}
                </span>

                <span className="type-section min-w-0 flex-1 truncate text-ink">
                  {member.name}
                </span>

                <ChevronRight
                  aria-hidden="true"
                  className="size-4 shrink-0 text-ink-faint"
                />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </BookingShell>
  );
}
