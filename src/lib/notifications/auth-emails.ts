import "server-only";

import { plainTextSelectors, render, toPlainText } from "@react-email/components";
import type { ReactNode } from "react";

import ResetPassword from "../../../emails/reset-password";
import VerifyEmail from "../../../emails/verify-email";

import { getMailer } from "./mailer";

/**
 * The two emails an owner account needs.
 *
 * Booking mail is an outbox job (see the `notifications` table) because a
 * Resend outage must not roll back a confirmed appointment. These two are not:
 * nobody is waiting on a database transaction, and a sign-up whose
 * verification link never left the building has failed in a way the person in
 * front of the form should hear about straight away.
 */

/** Render once, and derive the text part from the same markup. */
async function renderBoth(node: ReactNode) {
  const html = await render(node);
  return { html, text: toPlainText(html, { selectors: plainTextSelectors }) };
}

export async function sendVerificationEmail(params: {
  to: string;
  name: string;
  url: string;
}): Promise<void> {
  const { html, text } = await renderBoth(
    VerifyEmail({ name: params.name, url: params.url }),
  );

  await getMailer().send({
    to: params.to,
    subject: "Confirm your email",
    html,
    text,
  });
}

export async function sendPasswordResetEmail(params: {
  to: string;
  name: string;
  url: string;
}): Promise<void> {
  const { html, text } = await renderBoth(
    ResetPassword({ name: params.name, url: params.url }),
  );

  await getMailer().send({
    to: params.to,
    subject: "Choose a new password",
    html,
    text,
  });
}
