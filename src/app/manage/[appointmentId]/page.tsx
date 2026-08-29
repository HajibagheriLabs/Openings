import { CalendarPlus, Mail, MapPin, Phone } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { BookingShell } from "@/components/booking/booking-shell";
import { BookingSummaryPanel } from "@/components/booking/booking-summary";
import { TimezoneNote } from "@/components/booking/timezone-note";
import { EmptyState } from "@/components/empty-state";
import { PillButton } from "@/components/pill-button";
import { AppointmentStatusBadge } from "@/components/status-badge";
import type { BookingSummary } from "@/lib/booking/details";
import { MANAGE_TOKEN_PARAM } from "@/lib/notifications/links";
import { formatCents } from "@/lib/money";
import { loadManageView, type ManageView } from "@/server/booking/manage";

/**
 * "My appointment" — the page every confirmation, reminder and reschedule
 * links to.
 *
 * NO ACCOUNT, NO SESSION. The secret is in the URL and that is the whole
 * mechanism; customers in this product are guests by design. Anything that
 * does not present a matching token gets the same empty state as an id that
 * does not exist.
 *
 * WHAT IT DOES TODAY: states the appointment, in the business's clock and in
 * the reader's when they differ, with what was paid and what is owed, the
 * policy they agreed to, and the two calendar fallbacks. Cancelling and moving
 * an appointment from here are the next step's work; until then the page says
 * plainly how to do both, rather than showing buttons that do nothing.
 */
export const metadata: Metadata = {
  title: "Your appointment",
  /* Never indexed. The URL contains a secret and the content is one person's. */
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function ManagePage({
  params,
  searchParams,
}: {
  params: Promise<{ appointmentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { appointmentId } = await params;
  const query = await searchParams;
  const raw = query[MANAGE_TOKEN_PARAM];
  const token = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);

  const view = await loadManageView(appointmentId, token);

  if (!view) {
    return (
      <BookingShell>
        <EmptyState
          title="No appointment here"
          description="This link is not valid any more, or it was never quite right. Check the most recent email you had about the booking — the link in it always points at the current version."
        />
      </BookingShell>
    );
  }

  return <ManageAppointment view={view} />;
}

function ManageAppointment({ view }: { view: ManageView }) {
  const { booking } = view;
  const live = view.status === "confirmed";

  /* Already resolved — the view model the emails read carries every one of
     these, worked out by the same code. Building it a second time here is how
     the page and the confirmation would eventually disagree. */
  const summary: BookingSummary = {
    serviceName: booking.serviceName,
    staffName: booking.staffName,
    startsAt: booking.times.startsAt,
    endsAt: booking.times.endsAt,
    timeZone: booking.times.timeZone,
    durationMin: booking.durationMin,
    currency: booking.currency,
    priceCents: booking.priceCents,
    depositCents: booking.depositCents,
    balanceCents: booking.balanceCents,
    policyLines: booking.policyLines,
  };

  return (
    <BookingShell
      header={
        <header className="flex flex-col gap-3">
          <h1 className="type-page-title text-ink">{booking.businessName}</h1>

          {view.address ? (
            <p className="type-body-sm flex items-start gap-2 text-ink-muted">
              <MapPin aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span className="whitespace-pre-line">{view.address}</span>
            </p>
          ) : null}

          <TimezoneNote
            timeZone={view.timeZone}
            instant={booking.times.startsAt}
          />
        </header>
      }
    >
      <section className="flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <h2 className="type-page-title text-ink">Your appointment</h2>
          <AppointmentStatusBadge status={view.status} />
        </div>

        {!live ? (
          <p className="type-body text-ink-muted">
            {view.cancelledBy === "business"
              ? `${booking.businessName} cancelled this appointment.`
              : view.status === "cancelled"
                ? "This appointment was cancelled."
                : "This appointment is in the past."}
            {view.cancellationReason ? ` ${view.cancellationReason}` : ""}
            {view.refundedCents && view.refundedCents > 0
              ? ` ${formatCents(view.refundedCents, booking.currency)} was refunded to the card you paid with.`
              : ""}
          </p>
        ) : null}

        <BookingSummaryPanel
          summary={summary}
          tone={live ? "confirmed" : "pending"}
          depositPaid={booking.depositPaid}
        />

        {live ? (
          <div className="flex flex-col gap-3">
            <p className="type-section text-ink">Add it to your calendar</p>

            <div className="flex flex-wrap gap-3">
              <PillButton asChild variant="secondary">
                <a href={booking.icsUrl}>
                  <CalendarPlus aria-hidden="true" className="size-4" />
                  Download the invitation
                </a>
              </PillButton>

              <PillButton asChild variant="secondary">
                <a
                  href={booking.googleUrl}
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  Add to Google Calendar
                </a>
              </PillButton>
            </div>
          </div>
        ) : null}

        {live ? (
          <p className="type-body text-ink-muted">
            Need to move it or cancel? Get in touch and they will sort it out.
          </p>
        ) : (
          <PillButton asChild>
            <Link href={view.rebookPath}>Book another time</Link>
          </PillButton>
        )}

        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <p className="type-body-sm flex items-center gap-2 text-ink-muted">
            <Mail aria-hidden="true" className="size-3.5 shrink-0" />
            <a
              className="underline underline-offset-2"
              href={`mailto:${booking.contactEmail}`}
            >
              {booking.contactEmail}
            </a>
          </p>

          {booking.contactPhone ? (
            <p className="type-body-sm flex items-center gap-2 text-ink-muted">
              <Phone aria-hidden="true" className="size-3.5 shrink-0" />
              <a
                className="underline underline-offset-2"
                href={`tel:${booking.contactPhone.replace(/\s+/g, "")}`}
              >
                {booking.contactPhone}
              </a>
            </p>
          ) : null}
        </div>
      </section>
    </BookingShell>
  );
}
