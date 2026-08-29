import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { ReactNode } from "react";

import { APP_NAME } from "../../src/lib/brand";

/**
 * The shell every transactional email shares.
 *
 * Email clients strip stylesheets, custom properties and web fonts, so the
 * Daybook tokens are written out as literal hex here and the two faces fall
 * back to system stacks. The values are the same ones in globals.css — warm
 * grey canvas, white surface, one verdigris accent.
 */

export const canvas = "#EFEDE9";
export const surface = "#FFFFFF";
/** Inputs at rest, and the quiet panel a set of facts sits in. */
export const surfaceSunk = "#E5E2DD";
export const line = "#DAD6D0";
export const lineStrong = "#C4BFB7";
export const ink = "#1A1B19";
export const inkMuted = "#5F615C";
export const inkFaint = "#8E918B";

export const accent = "#14655C";
export const accentContrast = "#FFFFFF";

/**
 * Chrome only, and only three of them.
 *
 * These are the SYSTEM state colours, allowed on a badge or a rule and never
 * on anything representing time. A cancellation email is not printed in red;
 * it says "cancelled" in words, and the one hairline above the heading is the
 * only place the state is allowed to be a colour.
 */
export const confirmed = "#2E7D5B";
export const cancelled = "#B3453B";

/** Times and headings. Body copy uses the grotesque stack. */
export const displayFont =
  "Epilogue, 'Helvetica Neue', Helvetica, Arial, sans-serif";
export const bodyFont =
  "'Hanken Grotesk', 'Helvetica Neue', Helvetica, Arial, sans-serif";

/**
 * The line at the bottom of an owner-account email.
 *
 * Booking mail says something different — see `bookingFooter` in
 * ./booking.tsx — because "someone used this address to manage a business" is
 * a sentence that would baffle a customer who simply booked a haircut.
 */
const OWNER_ACCOUNT_FOOTER = (
  <>
    You are receiving this because someone used this address to manage a
    business on {APP_NAME}. If that was not you, ignore this message and nothing
    will change.
  </>
);

export function EmailLayout({
  preview,
  footer = OWNER_ACCOUNT_FOOTER,
  children,
}: {
  /** The one line shown next to the subject in an inbox list. */
  preview: string;
  /** Why this message arrived. Every email carries one; the wording differs. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body
        style={{
          backgroundColor: canvas,
          fontFamily: bodyFont,
          margin: 0,
          padding: "32px 0",
        }}
      >
        <Container
          style={{
            backgroundColor: surface,
            border: `1px solid ${line}`,
            borderRadius: "10px",
            margin: "0 auto",
            maxWidth: "560px",
            padding: "32px",
          }}
        >
          <Text
            style={{
              color: inkFaint,
              fontSize: "11px",
              fontWeight: 600,
              letterSpacing: "0.06em",
              margin: "0 0 24px",
              textTransform: "uppercase",
            }}
          >
            {APP_NAME}
          </Text>

          {children}

          <Hr style={{ borderColor: line, margin: "32px 0 16px" }} />

          <Text
            style={{
              color: inkFaint,
              fontSize: "13.5px",
              lineHeight: 1.5,
              margin: 0,
            }}
          >
            {footer}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return (
    <Text
      style={{
        color: ink,
        fontFamily: displayFont,
        fontSize: "22px",
        fontWeight: 600,
        lineHeight: 1.25,
        margin: "0 0 12px",
      }}
    >
      {children}
    </Text>
  );
}

export function Paragraph({ children }: { children: ReactNode }) {
  return (
    <Text
      style={{
        color: inkMuted,
        fontSize: "15px",
        lineHeight: 1.55,
        margin: "0 0 16px",
      }}
    >
      {children}
    </Text>
  );
}

/**
 * The raw link, printed under every button.
 *
 * Plenty of mail clients mangle or strip buttons, and some people copy the URL
 * into a different browser on purpose. Showing it is the difference between a
 * dead end and a working link.
 */
export function FallbackUrl({ url }: { url: string }) {
  return (
    <Section style={{ marginTop: "24px" }}>
      <Text
        style={{
          color: inkFaint,
          fontSize: "13.5px",
          lineHeight: 1.5,
          margin: "0 0 4px",
        }}
      >
        If the button does not work, paste this into your browser:
      </Text>
      <Text
        style={{
          color: accent,
          fontSize: "13.5px",
          lineHeight: 1.5,
          margin: 0,
          wordBreak: "break-all",
        }}
      >
        {url}
      </Text>
    </Section>
  );
}

export const buttonStyle = {
  backgroundColor: accent,
  borderRadius: "999px",
  color: accentContrast,
  display: "inline-block",
  fontSize: "15px",
  fontWeight: 600,
  padding: "13px 28px",
  textDecoration: "none",
} as const;
