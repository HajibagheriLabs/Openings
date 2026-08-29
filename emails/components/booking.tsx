import { Button, Hr, Link, Section, Text } from "@react-email/components";
import type { ReactNode } from "react";

import {
  formatDuration,
  formatInstantDate,
  formatInstantRange,
  formatTimeZoneAbbreviation,
} from "../../src/components/time-text";
import { formatCents } from "../../src/lib/money";
import type { EmailBooking, EmailTimes } from "../../src/lib/notifications/view";

import {
  accent,
  accentContrast,
  bodyFont,
  displayFont,
  ink,
  inkFaint,
  inkMuted,
  line,
  surfaceSunk,
} from "./layout";

/**
 * The blocks every booking email is built from.
 *
 * ONE PLACE, SEVEN TEMPLATES. A confirmation, a reminder and a cancellation
 * say very different things, but they all have to state the same appointment
 * the same way — and a time rendered by two slightly different pieces of
 * markup is how a customer ends up reading two slightly different times.
 *
 * EVERY STYLE IS INLINE. Gmail strips `<style>` blocks, Outlook ignores most of
 * what survives, and no client loads a web font, so the Daybook tokens are
 * written as literal hex and the two faces fall back to system stacks. Layout
 * is tables — via React Email's primitives — for the same reason.
 */

/* ===========================================================================
   The footer — why this message arrived
   =========================================================================== */

/**
 * The customer's version, and it names the BUSINESS rather than the product.
 *
 * Somebody who booked a haircut has a relationship with a salon, not with the
 * software the salon uses. "You are receiving this because you booked with
 * Rosa's Hair Studio" is a sentence they can act on; the product's own name
 * belongs at the top of the message, where it already is.
 *
 * NOTHING ELSE GOES HERE. No tooling credit, no "built with", no generator
 * line — the footer is one of the two places, alongside the .ics PRODID, where
 * that sort of thing gets into a shipped product by accident.
 */
export function bookingFooter(businessName: string): ReactNode {
  return (
    <>
      You are receiving this because you booked with {businessName}. Questions
      about your appointment go to them.
    </>
  );
}

/** The owner's version. Their own business, their own booking page. */
export function ownerFooter(businessName: string): ReactNode {
  return (
    <>
      You are receiving this because you manage {businessName}. Change where
      these go in your settings.
    </>
  );
}

/* ===========================================================================
   The time — the one thing in this product that is a headline
   =========================================================================== */

/**
 * The date, the time range, and the zone it is in.
 *
 * THE TIME IS SET LIKE A HEADLINE, because in this product it is one. Epilogue
 * at 28px with tabular figures, above a quieter line naming the zone.
 *
 * THE ZONE IS ALWAYS NAMED, and when the customer's own zone shows a different
 * clock the same instant is printed a second time, labelled, underneath. Never
 * instead: the first time is the shop's wall clock, which is the time they
 * will be standing in the doorway at, and quietly converting it would mean the
 * email, the calendar invite and the shop's front door gave three different
 * answers.
 */
export function TimeHeadline({
  times,
  strikeThrough = false,
}: {
  times: EmailTimes;
  /** For a cancellation, or the old half of a reschedule. */
  strikeThrough?: boolean;
}) {
  const zoneLabel = formatTimeZoneAbbreviation(times.startsAt, times.timeZone);
  const struck = strikeThrough ? { textDecoration: "line-through" } : {};

  return (
    <Section style={{ margin: "0 0 20px" }}>
      <Text
        style={{
          color: inkMuted,
          fontFamily: bodyFont,
          fontSize: "15px",
          lineHeight: 1.4,
          margin: "0 0 4px",
          ...struck,
        }}
      >
        {formatInstantDate(times.startsAt, times.timeZone)}
      </Text>

      <Text
        style={{
          color: strikeThrough ? inkFaint : ink,
          fontFamily: displayFont,
          fontSize: "28px",
          fontWeight: 600,
          letterSpacing: "-0.01em",
          lineHeight: 1.1,
          margin: "0 0 6px",
          ...struck,
        }}
      >
        {formatInstantRange(times.startsAt, times.endsAt, times.timeZone)}
      </Text>

      <Text
        style={{
          color: inkFaint,
          fontFamily: bodyFont,
          fontSize: "13.5px",
          lineHeight: 1.5,
          margin: 0,
        }}
      >
        {zoneLabel} · {times.timeZone.replace(/_/g, " ")} (business time)
      </Text>

      {times.visitorTimeZone ? (
        <Text
          style={{
            color: inkFaint,
            fontFamily: bodyFont,
            fontSize: "13.5px",
            lineHeight: 1.5,
            margin: "4px 0 0",
          }}
        >
          Where you are that is{" "}
          {formatInstantRange(
            times.startsAt,
            times.endsAt,
            times.visitorTimeZone,
          )}{" "}
          on {formatInstantDate(times.startsAt, times.visitorTimeZone)} (
          {times.visitorTimeZone.replace(/_/g, " ")}).
        </Text>
      ) : null}
    </Section>
  );
}

/* ===========================================================================
   Fact rows
   =========================================================================== */

export interface Fact {
  label: string;
  value: ReactNode;
}

/**
 * A quiet panel of label/value pairs.
 *
 * Two columns as a table, because that is the only two-column layout every
 * mail client in use has agreed on. The label column has a fixed width so the
 * values line up down the message.
 */
export function FactRows({ facts }: { facts: Fact[] }) {
  if (facts.length === 0) {
    return null;
  }

  return (
    <Section
      style={{
        backgroundColor: surfaceSunk,
        borderRadius: "10px",
        margin: "0 0 20px",
        padding: "16px 20px",
      }}
    >
      {/* Marked so the plain-text conversion renders it as rows rather than
          running every label and value together into one paragraph — see
          FACT_TABLE_SELECTOR in src/lib/notifications/compose.ts. React
          Email's own Section and Container are also tables, so the plain-text
          rule has to target this one specifically. */}
      <table
        cellPadding={0}
        cellSpacing={0}
        data-facts="true"
        style={{ borderCollapse: "collapse", width: "100%" }}
      >
        <tbody>
          {facts.map((fact) => (
            <tr key={fact.label}>
              <td
                style={{
                  color: inkFaint,
                  fontFamily: bodyFont,
                  fontSize: "11px",
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  paddingBottom: "8px",
                  paddingRight: "16px",
                  textTransform: "uppercase",
                  verticalAlign: "top",
                  whiteSpace: "nowrap",
                  width: "34%",
                }}
              >
                {fact.label}
              </td>
              <td
                style={{
                  color: ink,
                  fontFamily: bodyFont,
                  fontSize: "15px",
                  lineHeight: 1.5,
                  paddingBottom: "8px",
                  verticalAlign: "top",
                }}
              >
                {fact.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

/** Service, who, how long, and where — the facts every message repeats. */
export function appointmentFacts(booking: EmailBooking): Fact[] {
  return [
    { label: "Service", value: booking.serviceName },
    { label: "With", value: booking.staffName },
    { label: "Length", value: formatDuration(booking.durationMin) },
    ...(booking.location ? [{ label: "Where", value: booking.location }] : []),
  ];
}

/**
 * Money, as three lines rather than one.
 *
 * What left the account, what to bring, and the total. A single figure is the
 * number that causes the phone call; the split is the number that prevents it.
 * Returns nothing at all when the service is free — an absent price is an
 * absent price, not a row reading "0.00".
 */
export function moneyFacts(booking: EmailBooking): Fact[] {
  if (booking.priceCents <= 0) {
    return [];
  }

  if (booking.depositCents <= 0) {
    return [
      {
        label: "To pay",
        value: `${formatCents(booking.priceCents, booking.currency)} on the day`,
      },
    ];
  }

  return [
    {
      label: booking.depositPaid ? "Deposit paid" : "Deposit due",
      value: formatCents(booking.depositCents, booking.currency),
    },
    ...(booking.balanceCents > 0
      ? [
          {
            label: "On the day",
            value: formatCents(booking.balanceCents, booking.currency),
          },
        ]
      : []),
    { label: "Total", value: formatCents(booking.priceCents, booking.currency) },
  ];
}

/* ===========================================================================
   Buttons and links
   =========================================================================== */

export function PrimaryButton({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Button
      href={href}
      style={{
        backgroundColor: accent,
        borderRadius: "999px",
        color: accentContrast,
        display: "inline-block",
        fontFamily: bodyFont,
        fontSize: "15px",
        fontWeight: 600,
        padding: "13px 28px",
        textDecoration: "none",
      }}
    >
      {children}
    </Button>
  );
}

/**
 * "Add to calendar", said twice, in words.
 *
 * THE ATTACHED INVITE IS THE REAL ONE — it carries the UID and the sequence, so
 * a later change moves the event the customer already has instead of adding a
 * second one. These two links exist because attachment handling varies wildly:
 * a webmail that decides the .ics is a file offers a download, and a phone that
 * cannot open a downloaded file offers nothing at all.
 *
 * They are named as what they are rather than dressed as identical buttons.
 * The hosted .ics is the same invitation; the Google link is a plain event with
 * no identity, which will not move when the appointment does — so it is called
 * a Google link, not "add to calendar" in general.
 */
export function CalendarLinks({
  booking,
  attached = true,
}: {
  booking: EmailBooking;
  /** False on a message that carries no calendar part, such as a reminder. */
  attached?: boolean;
}) {
  return (
    <Section style={{ margin: "0 0 20px" }}>
      <Text
        style={{
          color: inkMuted,
          fontFamily: bodyFont,
          fontSize: "13.5px",
          lineHeight: 1.5,
          margin: "0 0 6px",
        }}
      >
        {attached
          ? "The invitation is attached. If your mail app does not offer to add it:"
          : "Not in your calendar yet?"}
      </Text>
      <Text
        style={{
          color: inkMuted,
          fontFamily: bodyFont,
          fontSize: "13.5px",
          lineHeight: 1.6,
          margin: 0,
        }}
      >
        <Link href={booking.icsUrl} style={{ color: accent }}>
          Download the invitation
        </Link>
        {" · "}
        <Link href={booking.googleUrl} style={{ color: accent }}>
          Add to Google Calendar
        </Link>
      </Text>
    </Section>
  );
}

/** The cancellation policy, in the sentences the customer ticked a box beside. */
export function PolicyLines({ lines }: { lines: string[] }) {
  if (lines.length === 0) {
    return null;
  }

  return (
    <Section style={{ margin: "0 0 8px" }}>
      <Hr style={{ borderColor: line, margin: "0 0 16px" }} />
      {lines.map((sentence) => (
        <Text
          key={sentence}
          style={{
            color: inkFaint,
            fontFamily: bodyFont,
            fontSize: "13.5px",
            lineHeight: 1.5,
            margin: "0 0 4px",
          }}
        >
          {sentence}
        </Text>
      ))}
    </Section>
  );
}

/** How to reach the business. Always present: an email is not a support desk. */
export function ContactLine({ booking }: { booking: EmailBooking }) {
  return (
    <Text
      style={{
        color: inkFaint,
        fontFamily: bodyFont,
        fontSize: "13.5px",
        lineHeight: 1.5,
        margin: "16px 0 0",
      }}
    >
      {booking.businessName} ·{" "}
      <Link href={`mailto:${booking.contactEmail}`} style={{ color: accent }}>
        {booking.contactEmail}
      </Link>
      {booking.contactPhone ? ` · ${booking.contactPhone}` : ""}
    </Text>
  );
}
