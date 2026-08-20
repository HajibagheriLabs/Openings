import { Button } from "@react-email/components";

import {
  EmailLayout,
  FallbackUrl,
  Paragraph,
  Title,
  buttonStyle,
} from "./components/layout";

export interface VerifyEmailProps {
  /** The owner's name, as typed on the sign-up form. */
  name: string;
  /** Better Auth's one-time verification URL. */
  url: string;
}

/**
 * Sent once, on sign-up. Until it is followed, the account cannot sign in —
 * `requireEmailVerification` is on, because the address on the business row is
 * where cancellations and no-shows land.
 */
export default function VerifyEmail({ name, url }: VerifyEmailProps) {
  return (
    <EmailLayout preview="Confirm your email address to finish setting up.">
      <Title>Confirm your email</Title>

      <Paragraph>
        Hello {name}. Confirm this address and you can finish setting up your
        business — opening hours, your first service, and a booking page.
      </Paragraph>

      <Button href={url} style={buttonStyle}>
        Confirm my email
      </Button>

      <FallbackUrl url={url} />

      <Paragraph>The link works once, and expires in 24 hours.</Paragraph>
    </EmailLayout>
  );
}

VerifyEmail.PreviewProps = {
  name: "Rosa",
  url: "http://localhost:3000/api/auth/verify-email?token=preview",
} satisfies VerifyEmailProps;
