import { Section, Text } from "@react-email/components";

import {
  appointmentFacts,
  ContactLine,
  FactRows,
  ownerFooter,
  PrimaryButton,
  TimeHeadline,
} from "../components/booking";
import {
  bodyFont,
  EmailLayout,
  inkFaint,
  Paragraph,
  Title,
} from "../components/layout";

import { PREVIEW_BOOKING } from "./preview";

import type { EmailBooking, EmailTimes } from "../../src/lib/notifications/view";

export interface OwnerRescheduleProps {
  booking: EmailBooking;
  /** Where it moved FROM. Struck through above the new time. */
  previous: EmailTimes;
  agendaUrl: string;
}

/**
 * To the OWNER: a customer moved their own appointment.
 *
 * THE DIARY CHANGED WITHOUT ANYBODY AT THE BUSINESS TOUCHING IT, which is the
 * one thing a business must not discover by looking. It leads with both times
 * for the same reason the customer's copy does — a message stating only the
 * new time makes the reader hunt for what changed — and it names the customer
 * first, because that is how an owner identifies an appointment.
 *
 * NO CALENDAR PART. The owner's calendar of record is the admin agenda, and an
 * organizer receiving their own REQUEST is the case mail clients handle least
 * consistently. The agenda link is the action.
 */
export default function OwnerReschedule({
  booking,
  previous,
  agendaUrl,
}: OwnerRescheduleProps) {
  return (
    <EmailLayout
      preview={`${booking.customerName} moved their appointment.`}
      footer={ownerFooter(booking.businessName)}
    >
      <Title>An appointment moved</Title>

      <Paragraph>
        {booking.customerName} moved their {booking.serviceName} with{" "}
        {booking.staffName}. Nothing is needed from you — the diary is already
        up to date.
      </Paragraph>

      <Label>Was</Label>
      <TimeHeadline times={previous} strikeThrough />

      <Label>Now</Label>
      <TimeHeadline times={booking.times} />

      <FactRows
        facts={[
          { label: "Customer", value: booking.customerName },
          { label: "Email", value: booking.customerEmail },
          ...(booking.customerPhone
            ? [{ label: "Phone", value: booking.customerPhone }]
            : []),
          ...appointmentFacts(booking),
        ]}
      />

      <Paragraph>
        The deposit follows the appointment. Nothing was charged and nothing was
        refunded.
      </Paragraph>

      <PrimaryButton href={agendaUrl}>Open the agenda</PrimaryButton>

      <ContactLine booking={booking} />
    </EmailLayout>
  );
}

function Label({ children }: { children: string }) {
  return (
    <Section style={{ margin: "0 0 4px" }}>
      <Text
        style={{
          color: inkFaint,
          fontFamily: bodyFont,
          fontSize: "11px",
          fontWeight: 600,
          letterSpacing: "0.06em",
          margin: "0 0 6px",
          textTransform: "uppercase",
        }}
      >
        {children}
      </Text>
    </Section>
  );
}

OwnerReschedule.PreviewProps = {
  booking: PREVIEW_BOOKING,
  previous: {
    startsAt: "2026-09-02T09:00:00.000Z",
    endsAt: "2026-09-02T10:30:00.000Z",
    timeZone: "Europe/Berlin",
    visitorTimeZone: null,
  },
  agendaUrl: "https://openings.example/admin/calendar",
} satisfies OwnerRescheduleProps;
