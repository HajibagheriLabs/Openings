import { Link, Section, Text } from "@react-email/components";

import { bookingFooter, ContactLine, PrimaryButton } from "../components/booking";
import {
  accent,
  bodyFont,
  EmailLayout,
  ink,
  inkFaint,
  Paragraph,
  Title,
} from "../components/layout";
import {
  formatInstantDate,
  formatInstantRange,
} from "../../src/components/time-text";
import { formatCents } from "../../src/lib/money";

import { PREVIEW_BOOKING } from "./preview";

import type { EmailBooking } from "../../src/lib/notifications/view";

export interface SlotLostProps {
  booking: EmailBooking;
  /** What went back to the card, in integer cents. */
  refundedCents: number;
  /** The nearest openings for the same service, soonest first, each with a link. */
  alternatives: { startsAt: string; endsAt: string; url: string }[];
  /** The picker, for when none of the offered times suit. */
  rebookUrl: string;
}

/**
 * The rare one: paid for a slot that had already gone.
 *
 * The sequence behind it is in src/server/payments/webhook.ts — the hold
 * lapsed while the customer was on Stripe's page, somebody else took the time,
 * and the payment landed afterwards. The time is genuinely gone and there is
 * no clever recovery.
 *
 * SO THIS MESSAGE HAS EXACTLY THREE JOBS, IN THIS ORDER:
 *   1. Say the money is already back. It is the question they have before they
 *      have finished the first sentence, and the answer is not "contact us".
 *   2. Say plainly what happened, without hiding behind the passive voice and
 *      without apologising twice.
 *   3. Offer specific times. "Please try again" is a dead end; three real
 *      openings, each a link, is an offer.
 *
 * NO CALENDAR PART. There is nothing to put in a calendar, and there never was
 * — the appointment was never confirmed.
 */
export default function SlotLost({
  booking,
  refundedCents,
  alternatives,
  rebookUrl,
}: SlotLostProps) {
  return (
    <EmailLayout
      preview={`That time went before your payment reached us — ${formatCents(
        refundedCents,
        booking.currency,
      )} refunded.`}
      footer={bookingFooter(booking.businessName)}
    >
      <Title>That time went, and your money is back</Title>

      <Paragraph>
        {formatCents(refundedCents, booking.currency)} has been refunded in full
        to the card you paid with. Banks usually take a few working days to show
        it.
      </Paragraph>

      <Paragraph>
        Somebody else booked the {booking.serviceName} slot at{" "}
        {formatInstantRange(
          booking.times.startsAt,
          booking.times.endsAt,
          booking.times.timeZone,
        )}{" "}
        on {formatInstantDate(booking.times.startsAt, booking.times.timeZone)} in
        the minutes between you opening the payment page and finishing it. Your
        hold had run out by then, so the slot was back in the diary and the next
        person took it.
      </Paragraph>

      {alternatives.length > 0 ? (
        <Section style={{ margin: "0 0 20px" }}>
          <Text
            style={{
              color: inkFaint,
              fontFamily: bodyFont,
              fontSize: "11px",
              fontWeight: 600,
              letterSpacing: "0.06em",
              margin: "0 0 10px",
              textTransform: "uppercase",
            }}
          >
            Nearest openings for {booking.serviceName}
          </Text>

          {alternatives.map((option) => (
            <Text
              key={option.startsAt}
              style={{
                color: ink,
                fontFamily: bodyFont,
                fontSize: "15px",
                lineHeight: 1.6,
                margin: "0 0 6px",
              }}
            >
              <Link href={option.url} style={{ color: accent }}>
                {formatInstantDate(option.startsAt, booking.times.timeZone)},{" "}
                {formatInstantRange(
                  option.startsAt,
                  option.endsAt,
                  booking.times.timeZone,
                )}
              </Link>
            </Text>
          ))}
        </Section>
      ) : (
        <Paragraph>
          There is nothing close to that time free this week. The full diary has
          more.
        </Paragraph>
      )}

      <PrimaryButton href={rebookUrl}>See all open times</PrimaryButton>

      <ContactLine booking={booking} />
    </EmailLayout>
  );
}

SlotLost.PreviewProps = {
  booking: PREVIEW_BOOKING,
  refundedCents: 2000,
  alternatives: [
    {
      startsAt: "2026-09-03T14:00:00.000Z",
      endsAt: "2026-09-03T15:30:00.000Z",
      url: "https://openings.example/book/rosas-hair-studio?date=2026-09-03",
    },
    {
      startsAt: "2026-09-04T09:00:00.000Z",
      endsAt: "2026-09-04T10:30:00.000Z",
      url: "https://openings.example/book/rosas-hair-studio?date=2026-09-04",
    },
  ],
  rebookUrl: "https://openings.example/book/rosas-hair-studio",
} satisfies SlotLostProps;
