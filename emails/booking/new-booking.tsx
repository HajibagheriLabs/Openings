import {
  appointmentFacts,
  ContactLine,
  FactRows,
  moneyFacts,
  ownerFooter,
  PrimaryButton,
  TimeHeadline,
} from "../components/booking";
import { EmailLayout, Paragraph, Title } from "../components/layout";

import { PREVIEW_BOOKING } from "./preview";

import type { EmailBooking } from "../../src/lib/notifications/view";

export interface NewBookingProps {
  booking: EmailBooking;
  /** The owner's agenda for that day. Not the customer's manage link. */
  agendaUrl: string;
}

/**
 * The OWNER'S copy, and a different message about the same appointment.
 *
 * WHAT CHANGES FOR THIS AUDIENCE. The customer's name and phone number are the
 * headline facts here, not the service; the deposit line says what has been
 * TAKEN rather than what is owed; the note the customer wrote is printed in
 * full, because it is the one thing on this email the business has to read
 * before the day; and there is no manage link, no cancellation policy and no
 * calendar attachment — the owner's calendar of record is the agenda, and
 * sending an organizer their own invitation is the case mail clients handle
 * least consistently.
 *
 * IT STILL LEADS WITH THE TIME. An owner scanning a phone at the end of the
 * day is answering "when is this?" exactly like everybody else.
 */
export default function NewBooking({ booking, agendaUrl }: NewBookingProps) {
  return (
    <EmailLayout
      preview={`${booking.customerName} booked ${booking.serviceName}.`}
      footer={ownerFooter(booking.businessName)}
    >
      <Title>New booking</Title>

      <Paragraph>
        {booking.customerName} has booked {booking.serviceName} with{" "}
        {booking.staffName}.
      </Paragraph>

      <TimeHeadline times={booking.times} />

      <FactRows
        facts={[
          { label: "Customer", value: booking.customerName },
          { label: "Email", value: booking.customerEmail },
          ...(booking.customerPhone
            ? [{ label: "Phone", value: booking.customerPhone }]
            : []),
          ...appointmentFacts(booking),
          ...moneyFacts(booking),
        ]}
      />

      {booking.customerNote ? (
        <Paragraph>They left a note: “{booking.customerNote}”</Paragraph>
      ) : null}

      <PrimaryButton href={agendaUrl}>Open the agenda</PrimaryButton>

      <ContactLine booking={booking} />
    </EmailLayout>
  );
}

NewBooking.PreviewProps = {
  booking: PREVIEW_BOOKING,
  agendaUrl: "https://openings.example/admin/calendar?date=2026-09-03",
} satisfies NewBookingProps;
