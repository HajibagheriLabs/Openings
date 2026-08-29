import {
  appointmentFacts,
  bookingFooter,
  ContactLine,
  FactRows,
  PrimaryButton,
  TimeHeadline,
} from "../components/booking";
import { EmailLayout, Paragraph, Title } from "../components/layout";
import { formatCents } from "../../src/lib/money";

import { PREVIEW_BOOKING } from "./preview";

import type { EmailBooking } from "../../src/lib/notifications/view";

export interface BookingCancellationProps {
  booking: EmailBooking;
  /** Who cancelled. The customer already knows if it was them. */
  cancelledBy: "customer" | "business";
  /** The reason, when one was given. Shown verbatim, never paraphrased. */
  reason: string | null;
  /** What went back to the card, in integer cents. Null when nothing did. */
  refundedCents: number | null;
  /** Where to book again. The booking page for this business. */
  rebookUrl: string;
}

/**
 * Cancelled.
 *
 * NO CALENDAR ATTACHMENT IN THE USUAL SENSE — the message carries a
 * METHOD:CANCEL part and nothing else, so the customer's calendar strikes the
 * event out. Sending a cancellation alongside a still-valid REQUEST is how an
 * appointment ends up cancelled in the email and alive in the calendar.
 *
 * THE MONEY IS ANSWERED FIRST, before anything else, when there is money to
 * answer for. "Was I charged?" is the question somebody has while they are
 * reading the first line, and making them scroll for it is how a cancellation
 * becomes a support ticket.
 *
 * The tone is plain. Nobody is apologised to and nobody is blamed: a
 * cancellation is an ordinary thing that happens to a diary.
 */
export default function BookingCancellation({
  booking,
  cancelledBy,
  reason,
  refundedCents,
  rebookUrl,
}: BookingCancellationProps) {
  return (
    <EmailLayout
      preview={`Your appointment with ${booking.businessName} is cancelled.`}
      footer={bookingFooter(booking.businessName)}
    >
      <Title>Your appointment is cancelled</Title>

      <Paragraph>
        {cancelledBy === "business"
          ? `${booking.businessName} has cancelled the appointment below. Nothing further is expected of you.`
          : `That is done, ${booking.customerName}. The time below is back in the diary.`}
      </Paragraph>

      {refundedCents !== null && refundedCents > 0 ? (
        <Paragraph>
          {formatCents(refundedCents, booking.currency)} has been refunded to
          the card you paid with. Banks usually take a few working days to show
          it.
        </Paragraph>
      ) : booking.depositCents > 0 && booking.depositPaid ? (
        <Paragraph>
          The {formatCents(booking.depositCents, booking.currency)} deposit is
          not refunded — the cancellation falls inside the window you agreed to
          when booking.
        </Paragraph>
      ) : null}

      <TimeHeadline times={booking.times} strikeThrough />

      <FactRows facts={appointmentFacts(booking)} />

      {reason ? <Paragraph>Reason given: {reason}</Paragraph> : null}

      <Paragraph>Want another time? The diary is open.</Paragraph>

      <PrimaryButton href={rebookUrl}>Book again</PrimaryButton>

      <ContactLine booking={booking} />
    </EmailLayout>
  );
}

BookingCancellation.PreviewProps = {
  booking: PREVIEW_BOOKING,
  cancelledBy: "customer",
  reason: null,
  refundedCents: 2000,
  rebookUrl: "https://openings.example/book/rosas-hair-studio",
} satisfies BookingCancellationProps;
