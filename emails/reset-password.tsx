import { Button } from "@react-email/components";

import {
  EmailLayout,
  FallbackUrl,
  Paragraph,
  Title,
  buttonStyle,
} from "./components/layout";

export interface ResetPasswordProps {
  name: string;
  /** Better Auth's one-time reset URL. */
  url: string;
}

/**
 * Sent on request from /forgot-password.
 *
 * The page that triggers this says the same thing whether or not the address
 * has an account, so this message is the only place the difference shows —
 * which is what stops the form from being an account-enumeration oracle.
 */
export default function ResetPassword({ name, url }: ResetPasswordProps) {
  return (
    <EmailLayout preview="Choose a new password.">
      <Title>Choose a new password</Title>

      <Paragraph>
        Hello {name}. Use the link below to set a new password. Your current one
        keeps working until you do.
      </Paragraph>

      <Button href={url} style={buttonStyle}>
        Choose a new password
      </Button>

      <FallbackUrl url={url} />

      <Paragraph>
        The link works once, and expires in an hour. If you did not ask for it,
        you can ignore this message.
      </Paragraph>
    </EmailLayout>
  );
}

ResetPassword.PreviewProps = {
  name: "Rosa",
  url: "http://localhost:3000/reset-password?token=preview",
} satisfies ResetPasswordProps;
