import { CalendarPlus, Mail, MapPin, Phone } from "lucide-react";
import type { Metadata } from "next";
import { headers } from "next/headers";
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
import {
  clientAddressOf,
  consumeRateLimit,
  MANAGE_IP_RULE,
  MANAGE_TOKEN_RULE,
  rateLimitKey,
} from "@/server/booking/rate-limit";

/**
 * "My appointment" — the page every booking email links to.
 *
 * NO ACCOUNT, NO SESSION, NO APPOINTMENT ID. The address is
 * `/manage/<token>`, the token is hashed and looked up, and that is the whole
 * of the authorization. See the long note at the top of
 * src/server/booking/manage.ts for why looking a hash up is the right shape
 * here and where the token comes from.
 *
 * ═══ TWO OUTCOMES, NOT THREE ═══
 *
 * A live link gets the appointment. EVERYTHING ELSE — a mistyped token, a
 * forged one, and a genuine link whose appointment finished months ago — gets
 * one identical page that names no business. See the long note in
 * src/server/booking/manage.ts for why the expired case stopped being special:
 * a different answer for a real-but-old token is an oracle, and it leaks who
 * somebody booked with to anybody who later holds the URL.
 *
 * STILL NEVER A BARE 404. The page says what happened and what to do; it says
 * the same thing to everybody.
 *
 * ═══ RATE-LIMITED HERE, NOT ONLY IN THE ACTIONS ═══
 *
 * The actions behind this page have been limited since they were written. This
 * page had not been, and it is the cheaper target: a GET with a token in the
 * path is the most direct way to ask "is this token real?". It is counted now,
 * by address, against the same bucket the actions use.
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

  /**
   * COUNTED BEFORE THE LOOKUP, and counted whether or not the token is
   * well-formed.
   *
   * Counting only well-formed tokens, or only ones that found a row, would let
   * somebody walk the token space for free — the same reasoning as the note on
   * `gate` in src/server/actions/manage.ts. Both buckets are consumed, so an
   * attacker cannot keep one allowance warm by exhausting the other.
   */
  const address = clientAddressOf({ headers: await headers() });
  const presented = decodeURIComponent(token);

  const [byAddress, byToken] = await Promise.all([
    consumeRateLimit(db, rateLimitKey("manage:ip", address), MANAGE_IP_RULE),
    consumeRateLimit(
      db,
      rateLimitKey("manage:token", presented),
      MANAGE_TOKEN_RULE,
    ),
  ]);

  if (!byAddress.allowed || !byToken.allowed) {
    return <TooManyRequests />;
  }

  const resolved = await resolveManageToken(db, presented);

  if (resolved.status === "dead") {
    return <DeadLink />;
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

/**
 * The one page every unusable link gets.
 *
 * NAMES NO BUSINESS, NO DATE AND NO REASON — not out of unhelpfulness but
 * because saying any of them would answer "did this token ever mean anything?"
 * for whoever is asking. See src/server/booking/manage.ts.
 *
 * What it can do, and what actually solves this for a real customer, is point
 * at the thing that never stops working: the email the link came from. That
 * email names the business on every line of it, carries their phone number in
 * its footer, and — if the appointment moved — carries a newer link.
 */
function DeadLink() {
  return (
    <BookingShell>
      <section className="flex flex-col gap-5">
        <h1 className="type-page-title text-ink">This link does not work</h1>

        <p className="type-body text-ink-muted">
          Either the address was cut short somewhere between the email and the
          browser — links like this are long, and some apps break them across a
          line — or the appointment it pointed at is long past. Manage links
          stop working {MANAGE_TOKEN_TTL_DAYS} days after the appointment they
          were for.
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

/**
 * Too many requests from one place.
 *
 * Says nothing about the token, for the same reason `DeadLink` does not: a
 * distinct answer here would tell an attacker their guess was at least
 * well-formed. It reads as a network problem because from an ordinary
 * customer's point of view — several people in one office, one address — that
 * is exactly what it is.
 */
function TooManyRequests() {
  return (
    <BookingShell>
      <section className="flex flex-col gap-5">
        <h1 className="type-page-title text-ink">Too many requests</h1>

        <p className="type-body text-ink-muted">
          A lot of requests have come from your network in the last few minutes,
          so this one was not answered. Nothing has happened to your
          appointment. Wait a minute and reload the page.
        </p>
      </section>
    </BookingShell>
  );
}
