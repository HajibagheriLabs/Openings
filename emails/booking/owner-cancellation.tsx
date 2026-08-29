import {
  appointmentFacts,
  ContactLine,
  FactRows,
  ownerFooter,
  PrimaryButton,
  TimeHeadline,
} from "../components/booking";
import { EmailLayout, Paragraph, Title } from "../components/layout";
import { formatCents } from "../../src/lib/money";

import { PREVIEW_BOOKING } from "./preview";

import type { EmailBooking } from "../../src/lib/notifications/view";

export interface OwnerCancellationProps {
  booking: EmailBooking;
  /** What went back to the customer's card, in integer cents. Null when nothing did. */
  refundedCents: number | null;
  agendaUrl: string;
}

/**
 * To the OWNER: a customer cancelled their own appointment.
 *
 * TWO FACTS, IN THIS ORDER: the slot is free again, and here is what happened
 * to the money. The first is what the owner does something about — a freed
 * morning is a morning that can be refilled — and the second is the question
 * they would otherwise have to go to Stripe to answer.
 *
 * The money line is never omitted or softened. "Refunded in full" and "the
 * deposit stays with you" are both fine things to say; leaving the owner to
 * guess which one happened is not.
 *
 * NO CALENDAR PART, for the same reason as every other owner message.
 */
export default function OwnerCancellation({
  booking,
  refundedCents,
  agendaUrl,
}: OwnerCancellationProps) {
  const refunded = refundedCents !== null && refundedCents > 0;
  const hadDeposit = booking.depositCents > 0 && booking.depositPaid;

  return (
    <EmailLayout
      preview={`${booking.customerName} cancelled their appointment.`}
      footer={ownerFooter(booking.businessName)}
    >
      <Title>An appointment was cancelled</Title>

      <Paragraph>
        {booking.customerName} cancelled their {booking.serviceName} with{" "}
        {booking.staffName}. The slot is already back in the diary and open for
        booking.
      </Paragraph>

      <TimeHeadline times={booking.times} strikeThrough />

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

      {hadDeposit ? (
        <Paragraph>
          {refunded
            ? `The ${formatCents(
                refundedCents,
                booking.currency,
              )} deposit has been refunded to them automatically, in line with your cancellation policy.`
            : `The ${formatCents(
                booking.depositCents,
                booking.currency,
              )} deposit stays with you. They were told that on screen before they confirmed.`}
        </Paragraph>
      ) : null}

      <PrimaryButton href={agendaUrl}>Open the agenda</PrimaryButton>

      <ContactLine booking={booking} />
    </EmailLayout>
  );
}

OwnerCancellation.PreviewProps = {
  booking: PREVIEW_BOOKING,
  refundedCents: 2000,
  agendaUrl: "https://openings.example/admin/calendar",
} satisfies OwnerCancellationProps;
