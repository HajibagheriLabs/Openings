import {
  appointmentFacts,
  bookingFooter,
  CalendarLinks,
  ContactLine,
  FactRows,
  moneyFacts,
  PolicyLines,
  PrimaryButton,
  TimeHeadline,
} from "../components/booking";
import { EmailLayout, FallbackUrl, Paragraph, Title } from "../components/layout";

import { PREVIEW_BOOKING } from "./preview";

import type { EmailBooking } from "../../src/lib/notifications/view";

export interface BookingConfirmationProps {
  booking: EmailBooking;
}

/**
 * The one email in this product that must never fail to arrive.
 *
 * It is written in the order somebody actually reads it: WHEN, then what and
 * with whom, then what it costs, then how to change it. The time is first and
 * set as a headline because that is the fact being confirmed — everything else
 * is detail hanging off it.
 *
 * The calendar invitation is attached, with the two link fallbacks under it.
 * The manage link appears twice, as a button and as a plain URL, because half
 * the point of this message is that it is the thing the customer comes back to
 * three weeks later.
 */
export default function BookingConfirmation({
  booking,
}: BookingConfirmationProps) {
  return (
    <EmailLayout
      preview={`You are booked in with ${booking.businessName}.`}
      footer={bookingFooter(booking.businessName)}
    >
      <Title>You are booked in</Title>

      <Paragraph>
        Thanks {booking.customerName} — {booking.businessName} has you down for{" "}
        {booking.serviceName}.
      </Paragraph>

      <TimeHeadline times={booking.times} />

      <FactRows facts={[...appointmentFacts(booking), ...moneyFacts(booking)]} />

      <CalendarLinks booking={booking} />

      <Paragraph>
        Need to move it or cancel? Everything is on one page.
      </Paragraph>

      <PrimaryButton href={booking.manageUrl}>
        Manage this appointment
      </PrimaryButton>

      <FallbackUrl url={booking.manageUrl} />

      <PolicyLines lines={booking.policyLines} />

      <ContactLine booking={booking} />
    </EmailLayout>
  );
}

BookingConfirmation.PreviewProps = {
  booking: PREVIEW_BOOKING,
} satisfies BookingConfirmationProps;
