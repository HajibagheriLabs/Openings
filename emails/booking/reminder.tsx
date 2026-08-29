import {
  appointmentFacts,
  bookingFooter,
  CalendarLinks,
  ContactLine,
  FactRows,
  PolicyLines,
  PrimaryButton,
  TimeHeadline,
} from "../components/booking";
import { EmailLayout, FallbackUrl, Paragraph, Title } from "../components/layout";

import { PREVIEW_BOOKING } from "./preview";

import type { EmailBooking } from "../../src/lib/notifications/view";

export interface BookingReminderProps {
  booking: EmailBooking;
}

/**
 * Tomorrow.
 *
 * SHORTER THAN THE CONFIRMATION, ON PURPOSE. The person reading this already
 * agreed to everything; repeating the policy in full and re-stating the total
 * turns a useful nudge into a second confirmation, and the useful nudge is the
 * only reason to send it. What survives is the time, who and where, what is
 * left to pay, and one link.
 *
 * NO CALENDAR PART. The invite the confirmation carried has the same UID and
 * the same sequence, so re-sending it would change nothing in any calendar and
 * would push some clients into rendering this as an attachment instead of a
 * message. The "add to calendar" links stay, for anybody whose client swallowed
 * the first one.
 */
export default function BookingReminder({ booking }: BookingReminderProps) {
  const owing = booking.balanceCents > 0;

  return (
    <EmailLayout
      preview={`Tomorrow: ${booking.serviceName} at ${booking.businessName}.`}
      footer={bookingFooter(booking.businessName)}
    >
      <Title>Tomorrow at {booking.businessName}</Title>

      <Paragraph>
        A reminder, {booking.customerName} — nothing to do unless something has
        changed.
      </Paragraph>

      <TimeHeadline times={booking.times} />

      <FactRows facts={appointmentFacts(booking)} />

      {owing ? (
        <Paragraph>
          {booking.depositPaid
            ? "Your deposit is paid. The rest is settled on the day."
            : "Payment is settled on the day."}
        </Paragraph>
      ) : null}

      <CalendarLinks booking={booking} attached={false} />

      <Paragraph>Cannot make it? Let them know as early as you can.</Paragraph>

      <PrimaryButton href={booking.manageUrl}>
        Change or cancel
      </PrimaryButton>

      <FallbackUrl url={booking.manageUrl} />

      <PolicyLines lines={booking.policyLines.slice(0, 1)} />

      <ContactLine booking={booking} />
    </EmailLayout>
  );
}

BookingReminder.PreviewProps = {
  booking: PREVIEW_BOOKING,
} satisfies BookingReminderProps;
