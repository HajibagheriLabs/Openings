import { Section, Text } from "@react-email/components";

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
import {
  bodyFont,
  EmailLayout,
  FallbackUrl,
  inkFaint,
  Paragraph,
  Title,
} from "../components/layout";

import { PREVIEW_BOOKING } from "./preview";

import type { EmailBooking, EmailTimes } from "../../src/lib/notifications/view";

export interface BookingRescheduleProps {
  booking: EmailBooking;
  /** Where it moved FROM. Struck through above the new time. */
  previous: EmailTimes;
  /** Who moved it. Changes the first sentence and nothing else. */
  movedBy: "customer" | "business";
}

/**
 * It moved.
 *
 * BOTH TIMES, IN THIS ORDER: the old one struck through and quiet, the new one
 * as the headline. A message that states only the new time makes the reader
 * hunt for what changed; a message that states only the change ("moved by an
 * hour") makes them do arithmetic. Showing both, with the new one loud, is the
 * version somebody can act on at a glance.
 *
 * THE ATTACHED INVITE CARRIES THE SAME UID AND A HIGHER SEQUENCE, which is what
 * makes a calendar MOVE the existing event instead of adding a second one. That
 * is the whole reason this is a separate template rather than a second
 * confirmation.
 */
export default function BookingReschedule({
  booking,
  previous,
  movedBy,
}: BookingRescheduleProps) {
  return (
    <EmailLayout
      preview={`Your appointment with ${booking.businessName} has moved.`}
      footer={bookingFooter(booking.businessName)}
    >
      <Title>Your appointment has moved</Title>

      <Paragraph>
        {movedBy === "business"
          ? `${booking.businessName} has moved your ${booking.serviceName}. If the new time does not work, you can change it again or cancel below.`
          : `Done, ${booking.customerName} — your ${booking.serviceName} is now at the time below.`}
      </Paragraph>

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
          Was
        </Text>
      </Section>

      <TimeHeadline times={previous} strikeThrough />

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
          Now
        </Text>
      </Section>

      <TimeHeadline times={booking.times} />

      <FactRows facts={[...appointmentFacts(booking), ...moneyFacts(booking)]} />

      <CalendarLinks booking={booking} />

      <PrimaryButton href={booking.manageUrl}>
        Manage this appointment
      </PrimaryButton>

      <FallbackUrl url={booking.manageUrl} />

      <PolicyLines lines={booking.policyLines} />

      <ContactLine booking={booking} />
    </EmailLayout>
  );
}

BookingReschedule.PreviewProps = {
  booking: PREVIEW_BOOKING,
  previous: {
    startsAt: "2026-09-02T09:00:00.000Z",
    endsAt: "2026-09-02T10:30:00.000Z",
    timeZone: "Europe/Berlin",
    visitorTimeZone: "America/New_York",
  },
  movedBy: "customer",
} satisfies BookingRescheduleProps;
