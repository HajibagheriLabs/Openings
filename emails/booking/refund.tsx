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

export interface RefundNoticeProps {
  booking: EmailBooking;
  refundedCents: number;
  /** Whether the whole deposit went back, or only part of it. */
  full: boolean;
  /** Stripe's charge id, so the owner can find it in their dashboard. */
  chargeId: string;
  agendaUrl: string;
}

/**
 * To the OWNER: money went back to a customer.
 *
 * THE APPOINTMENT IS STILL IN THE DIARY, and saying so is the entire point of
 * this message. A refund issued from the Stripe dashboard is a decision about
 * money, not about the diary — it can be a goodwill gesture, a partial
 * adjustment, or the tail of a cancellation that already happened here. The
 * product does not cancel a booking on its own initiative because of one, so
 * somebody has to decide whether the chair is still booked, and this is how
 * they find out there is a decision to make.
 *
 * The customer is NOT copied. Stripe already emails them a refund receipt, and
 * a second message from the business saying the same thing invites a reply the
 * business would then have to answer.
 */
export default function RefundNotice({
  booking,
  refundedCents,
  full,
  chargeId,
  agendaUrl,
}: RefundNoticeProps) {
  return (
    <EmailLayout
      preview={`${formatCents(refundedCents, booking.currency)} refunded to ${
        booking.customerName
      }.`}
      footer={ownerFooter(booking.businessName)}
    >
      <Title>A deposit was refunded</Title>

      <Paragraph>
        {formatCents(refundedCents, booking.currency)}
        {full ? " — the whole deposit — " : " — part of the deposit — "}
        has gone back to {booking.customerName}.
      </Paragraph>

      <Paragraph>
        The appointment below is still in your diary. Refunding money does not
        cancel a booking, so if this one is not going ahead, cancel it in the
        agenda as well.
      </Paragraph>

      <TimeHeadline times={booking.times} />

      <FactRows
        facts={[
          { label: "Customer", value: booking.customerName },
          { label: "Email", value: booking.customerEmail },
          ...appointmentFacts(booking),
          {
            label: "Deposit",
            value: formatCents(booking.depositCents, booking.currency),
          },
          { label: "Refunded", value: formatCents(refundedCents, booking.currency) },
          { label: "Stripe charge", value: chargeId },
        ]}
      />

      <PrimaryButton href={agendaUrl}>Open the agenda</PrimaryButton>

      <ContactLine booking={booking} />
    </EmailLayout>
  );
}

RefundNotice.PreviewProps = {
  booking: PREVIEW_BOOKING,
  refundedCents: 2000,
  full: true,
  chargeId: "ch_3PreviewExample0001",
  agendaUrl: "https://openings.example/admin/calendar?date=2026-09-03",
} satisfies RefundNoticeProps;
