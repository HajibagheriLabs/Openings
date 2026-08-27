import { CheckCircle2, Mail } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { BookingShell } from "@/components/booking/booking-shell";
import { BookingSummaryPanel } from "@/components/booking/booking-summary";
import { PillButton } from "@/components/pill-button";
import type { ConfirmedBooking } from "@/lib/booking/details";

/**
 * Booked.
 *
 * A Server Component, and no progress line — there is nothing left to be
 * partway through. It is reached at its own address (`?step=booked`) and reads
 * the appointment from the cookie the hold left behind, so a refresh, a
 * back-button, or handing the phone to somebody all show the booking rather
 * than a picker offering a slot that is no longer for sale.
 *
 * The first thing it says is the time and the person, because that is what
 * somebody standing outside a shop wants to check. The email line is second
 * and states the address it went to, so a typo is obvious now rather than the
 * morning of the appointment.
 */
export function ConfirmedStep({
  booking,
  slug,
  header,
}: {
  booking: ConfirmedBooking;
  slug: string;
  header: ReactNode;
}) {
  return (
    <BookingShell header={header}>
      <section className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <CheckCircle2 aria-hidden="true" className="size-6 text-confirmed" />

          <h2 className="type-page-title text-ink">You are booked in</h2>

          <p className="type-body flex items-start gap-2 text-ink-muted">
            <Mail aria-hidden="true" className="mt-1 size-3.5 shrink-0" />
            <span>
              A confirmation is on its way to{" "}
              <span className="text-ink">{booking.email}</span>. It carries the
              link for changing or cancelling, and a calendar invite.
            </span>
          </p>
        </div>

        <BookingSummaryPanel
          summary={booking.summary}
          tone="confirmed"
          depositPaid={booking.depositPaid}
        />

        <p className="type-body-sm text-ink-faint">
          Nothing else to do. Keep the confirmation email — it is how you change
          this later.
        </p>

        <PillButton asChild variant="secondary">
          <Link href={`/book/${slug}`}>Book something else</Link>
        </PillButton>
      </section>
    </BookingShell>
  );
}
