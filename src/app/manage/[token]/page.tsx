import { CalendarPlus, Mail, MapPin, Phone } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { BookingShell } from "@/components/booking/booking-shell";
import { TimezoneNote } from "@/components/booking/timezone-note";
import { Card, CardBody, CardHeader } from "@/components/card";
import { ManageActions } from "@/components/manage/manage-actions";
import { PillButton } from "@/components/pill-button";
import { AppointmentStatusBadge } from "@/components/status-badge";
import {
  formatDuration,
  formatInstantDate,
  formatInstantRange,
  formatTimeZoneAbbreviation,
} from "@/components/time-text";
import { db } from "@/db";
import { MANAGE_TOKEN_TTL_DAYS } from "@/lib/booking/manage-policy";
import { formatCents } from "@/lib/money";
import { loadDayView, type DayView } from "@/lib/scheduling/day-view";
import {
  resolveManageToken,
  type BusinessContact,
  type ManageView,
} from "@/server/booking/manage";

/**
 * "My appointment" — the page every booking email links to.
 *
 * NO ACCOUNT, NO SESSION, NO APPOINTMENT ID. The address is
 * `/manage/<token>`, the token is hashed and looked up, and that is the whole
 * of the authorization. See the long note at the top of
 * src/server/booking/manage.ts for why looking a hash up is the right shape
 * here and where the token comes from.
 *
 * ═══ NEVER A BARE 404 ═══
 *
 * Three outcomes, three different pages, and none of them is a dead end. A live
 * link gets the appointment. An expired one gets the reason, the date it
 * lapsed, and the business's own phone number and email — we still know
 * exactly who they booked with. A token matching nothing gets an honest "we
 * cannot find this", because there genuinely is no business to name, plus the
 * one thing that always works: the most recent email they were sent.
 */
export const metadata: Metadata = {
  title: "Your appointment",
  /* Never indexed, never followed. The URL is a credential. */
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function ManagePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resolved = await resolveManageToken(db, decodeURIComponent(token));

  if (resolved.status === "unknown") {
    return <UnknownLink />;
  }

  if (resolved.status === "expired") {
    return (
      <ExpiredLink contact={resolved.contact} expiredAt={resolved.expiredAt} />
    );
  }

  const view = resolved.view;

  /**
   * The appointment's own day, drawn on the server.
   *
   * Loaded here rather than on the first click so opening the picker is
   * instant. Skipped entirely when the customer cannot move the appointment —
   * there is no reason to compute a day nobody will be shown.
   */
  const day = view.permissions.canReschedule
    ? ((
        await loadDayView({
          db,
          businessId: view.businessId,
          serviceId: view.serviceId,
          staffId: view.staffId,
          timeZone: view.timeZone,
          date: view.localDate,
          excludeAppointmentId: view.appointmentId,
          anchorStartsAt: view.booking.times.startsAt,
        })
      )?.view ?? null)
    : null;

  return <Appointment view={view} token={token} day={day} />;
}

/* ===========================================================================
   The appointment
   =========================================================================== */

function Appointment({
  view,
  token,
  day,
}: {
  view: ManageView;
  token: string;
  day: DayView | null;
}) {
  const { booking } = view;
  const live = view.status === "confirmed";

  return (
    <BookingShell header={<Header view={view} />}>
      <section className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <h2 className="type-page-title text-ink">Your appointment</h2>
          <AppointmentStatusBadge status={view.status} />
        </div>

        {!live ? <ClosedNotice view={view} /> : null}

        {/* ═══ THE TIME IS THE HEADLINE ═══
            Epilogue at time-lg with tabular figures, and the zone named under
            it — always, and a second time in the reader's own clock when the
            two differ. This page exists so somebody can check when they are
            due, and every other fact on it is detail hanging off this one. */}
        <Card>
          <CardBody className="flex flex-col gap-5">
            <div className="flex flex-col gap-1">
              <p className="type-body text-ink-muted">
                {formatInstantDate(booking.times.startsAt, view.timeZone)}
              </p>

              <p
                className={
                  live
                    ? "type-time-lg text-ink"
                    : "type-time-lg text-ink-faint line-through"
                }
              >
                {formatInstantRange(
                  booking.times.startsAt,
                  booking.times.endsAt,
                  view.timeZone,
                )}
              </p>

              <p className="type-body-sm text-ink-faint">
                {formatTimeZoneAbbreviation(
                  booking.times.startsAt,
                  view.timeZone,
                )}{" "}
                · {view.timeZone.replace(/_/g, " ")} (business time)
              </p>

              {booking.times.visitorTimeZone ? (
                <p className="type-body-sm text-ink-faint">
                  Where you are that is{" "}
                  {formatInstantRange(
                    booking.times.startsAt,
                    booking.times.endsAt,
                    booking.times.visitorTimeZone,
                  )}{" "}
                  ({booking.times.visitorTimeZone.replace(/_/g, " ")}).
                </p>
              ) : null}
            </div>

            <dl className="flex flex-col gap-3 border-t border-line pt-4">
              <Row label="Service" value={booking.serviceName} />
              <Row label="With" value={booking.staffName} />
              <Row label="Length" value={formatDuration(booking.durationMin)} />
              {booking.priceCents > 0 ? (
                <>
                  <Row
                    label="Price"
                    value={formatCents(booking.priceCents, booking.currency)}
                  />
                  {booking.depositCents > 0 ? (
                    <Row
                      label={booking.depositPaid ? "Deposit paid" : "Deposit due"}
                      value={formatCents(booking.depositCents, booking.currency)}
                    />
                  ) : null}
                  {booking.balanceCents > 0 ? (
                    <Row
                      label="Balance on the day"
                      value={formatCents(booking.balanceCents, booking.currency)}
                    />
                  ) : null}
                </>
              ) : null}
            </dl>
          </CardBody>
        </Card>

        {live ? (
          <ManageActions
            token={token}
            timeZone={view.timeZone}
            currency={booking.currency}
            startsAt={booking.times.startsAt}
            endsAt={booking.times.endsAt}
            depositCents={booking.depositCents}
            depositPaid={booking.depositPaid}
            refundDepositOnCancel={view.refundDepositOnCancel}
            canReschedule={view.permissions.canReschedule}
            canCancel={view.permissions.canCancel}
            rescheduleRefusal={view.permissions.rescheduleRefusal}
            cancelRefusal={view.permissions.cancelRefusal}
            initialDay={day}
          />
        ) : (
          <PillButton asChild>
            <Link href={view.contact.bookingPath}>Book another time</Link>
          </PillButton>
        )}

        {/* THE POLICY, IN THE SENTENCES THEY AGREED TO — on the page, not
            behind a link, not in a modal. The same lines the consent box
            printed at booking, from the same function. */}
        {booking.policyLines.length > 0 ? (
          <Card>
            <CardHeader title="If your plans change" />
            <CardBody className="flex flex-col gap-2">
              {booking.policyLines.map((line) => (
                <p key={line} className="type-body text-ink-muted">
                  {line}
                </p>
              ))}
            </CardBody>
          </Card>
        ) : null}

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

        <Contact contact={view.contact} />
      </section>
    </BookingShell>
  );
}

function Header({ view }: { view: ManageView }) {
  return (
    <header className="flex flex-col gap-3">
      <h1 className="type-page-title text-ink">{view.booking.businessName}</h1>

      {view.address ? (
        <p className="type-body-sm flex items-start gap-2 text-ink-muted">
          <MapPin aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span className="whitespace-pre-line">{view.address}</span>
        </p>
      ) : null}

      <TimezoneNote
        timeZone={view.timeZone}
        instant={view.booking.times.startsAt}
      />
    </header>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="type-label">{label}</dt>
      <dd className="type-body text-right text-ink">{value}</dd>
    </div>
  );
}

function ClosedNotice({ view }: { view: ManageView }) {
  const refunded = view.refundedCents && view.refundedCents > 0;

  return (
    <p className="type-body text-ink-muted">
      {view.status === "cancelled"
        ? view.cancelledBy === "business"
          ? `${view.booking.businessName} cancelled this appointment.`
          : "This appointment was cancelled."
        : "This appointment has already happened."}
      {view.cancellationReason ? ` ${view.cancellationReason}` : ""}
      {refunded
        ? ` ${formatCents(
            view.refundedCents!,
            view.booking.currency,
          )} was refunded to the card you paid with.`
        : ""}
    </p>
  );
}

function Contact({ contact }: { contact: BusinessContact }) {
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-4">
      <p className="type-body-sm flex items-center gap-2 text-ink-muted">
        <Mail aria-hidden="true" className="size-3.5 shrink-0" />
        <a
          className="underline underline-offset-2"
          href={`mailto:${contact.email}`}
        >
          {contact.email}
        </a>
      </p>

      {contact.phone ? (
        <p className="type-body-sm flex items-center gap-2 text-ink-muted">
          <Phone aria-hidden="true" className="size-3.5 shrink-0" />
          <a
            className="underline underline-offset-2"
            href={`tel:${contact.phone.replace(/\s+/g, "")}`}
          >
            {contact.phone}
          </a>
        </p>
      ) : null}
    </div>
  );
}

/* ===========================================================================
   The two ways a link fails
   =========================================================================== */

/**
 * The row is there and the link has simply run out of life.
 *
 * We know exactly who they booked with, so this hands over the business's own
 * details rather than apologising in the abstract. It also says WHEN it
 * lapsed, because "my link stopped working" and "my link stopped working three
 * weeks ago" are different conversations to have with a salon.
 */
function ExpiredLink({
  contact,
  expiredAt,
}: {
  contact: BusinessContact;
  expiredAt: Date;
}) {
  return (
    <BookingShell>
      <section className="flex flex-col gap-5">
        <h1 className="type-page-title text-ink">This link has expired</h1>

        <p className="type-body text-ink-muted">
          Manage links stop working {MANAGE_TOKEN_TTL_DAYS} days after the
          appointment they were for, so this one closed on{" "}
          <time dateTime={expiredAt.toISOString()}>
            {new Intl.DateTimeFormat("en-GB", {
              day: "numeric",
              month: "long",
              year: "numeric",
              timeZone: "UTC",
            }).format(expiredAt)}
          </time>
          . Nothing is wrong with your booking — there is just nothing left to
          change from here.
        </p>

        <p className="type-body text-ink-muted">
          {contact.name} can still help with anything about that appointment.
        </p>

        <Contact contact={contact} />

        <PillButton asChild>
          <Link href={contact.bookingPath}>Book with them again</Link>
        </PillButton>
      </section>
    </BookingShell>
  );
}

/**
 * Nothing matched the token.
 *
 * A mistyped link, a truncated one, a forged one, or one from a different
 * deployment. THERE IS NO BUSINESS TO NAME HERE and inventing one would be
 * worse than saying so — the token is the only thing that identifies anything,
 * and it identified nothing. What this can do is name the one thing that
 * always works, which is the most recent email they were sent.
 */
function UnknownLink() {
  return (
    <BookingShell>
      <section className="flex flex-col gap-5">
        <h1 className="type-page-title text-ink">We cannot find that booking</h1>

        <p className="type-body text-ink-muted">
          This link does not match an appointment. It usually means the address
          was cut short somewhere between the email and the browser — links like
          this are long, and some apps break them across a line.
        </p>

        <p className="type-body text-ink-muted">
          Open the most recent email you had about the booking and follow the
          link in that. It always points at the current version of your
          appointment, even if it has moved since.
        </p>

        <p className="type-body-sm text-ink-faint">
          If that does not work either, the business you booked with can find
          you by name — their details are at the bottom of any email they have
          sent you.
        </p>
      </section>
    </BookingShell>
  );
}
