import { Clock3 } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { BookingShell } from "@/components/booking/booking-shell";
import { PillButton } from "@/components/pill-button";
import type { PolicyRefusal } from "@/lib/booking/policy";

/**
 * Arriving at the details step without a hold.
 *
 * Somebody refreshed after the eight minutes ran out, or followed a link they
 * were sent, or came back to a tab they left open at lunchtime. A redirect
 * straight to the picker would be tidy and would leave them wondering what
 * happened to the form they had half filled in.
 *
 * So it says the thing plainly and gives one way forward. It never says "Oops",
 * never apologises, and never suggests the customer did anything wrong — a
 * hold running out is the product working exactly as promised.
 */
export function HoldGone({
  refusal,
  backHref,
  header,
}: {
  refusal: PolicyRefusal;
  /** The picker, with the service, staff member and day still chosen. */
  backHref: string;
  header: ReactNode;
}) {
  return (
    <BookingShell
      header={header}
      summary={
        <PillButton asChild block>
          <Link href={backHref}>Pick a time</Link>
        </PillButton>
      }
    >
      <section className="flex flex-col items-start gap-4 rounded-card border border-dashed border-line bg-surface px-5 py-6">
        <Clock3 aria-hidden="true" className="size-5 text-ink-faint" />

        <h2 className="type-section text-ink">Your slot is back in the day</h2>

        <p className="type-body text-ink-muted">{refusal.message}</p>
      </section>
    </BookingShell>
  );
}
