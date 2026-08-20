import "server-only";

import { Resend } from "resend";

import { serverEnv } from "@/env";

/**
 * The mailer boundary.
 *
 * Everything that sends email in this project goes through `getMailer()`, and
 * the implementation behind it depends on whether RESEND_API_KEY is set. With
 * a key, mail is sent. Without one, the message is printed to the server
 * console — including any link it carries — so the whole product, sign-up
 * verification and password reset included, works on a laptop with nothing but
 * a database.
 *
 * That fallback is not a stub. It is the reason a reviewer can clone this
 * repository and complete an account without registering for anything.
 */

export interface OutboundEmail {
  /** A single recipient. Transactional mail here never has more. */
  to: string;
  subject: string;
  html: string;
  /** Plain-text alternative. Never optional — it is what spam filters read. */
  text: string;
}

export interface Mailer {
  /** Named so logs and tests can say which implementation ran. */
  readonly name: string;
  send(email: OutboundEmail): Promise<void>;
}

/**
 * Prints the message instead of sending it. The text part is logged rather
 * than the HTML because it is the readable one, and any verification or reset
 * link appears in it verbatim, ready to paste into a browser.
 */
class ConsoleMailer implements Mailer {
  readonly name = "console";

  async send(email: OutboundEmail): Promise<void> {
    console.info(
      [
        "",
        "──── email (not sent: RESEND_API_KEY is not set) ────",
        `to:      ${email.to}`,
        `from:    ${serverEnv.EMAIL_FROM}`,
        `subject: ${email.subject}`,
        "",
        email.text,
        "────────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );
  }
}

class ResendMailer implements Mailer {
  readonly name = "resend";

  constructor(private readonly client: Resend) {}

  async send(email: OutboundEmail): Promise<void> {
    const { error } = await this.client.emails.send({
      from: serverEnv.EMAIL_FROM,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });

    // Resend reports failures in the payload rather than by throwing, so an
    // unchecked call would silently swallow a bounce.
    if (error) {
      throw new Error(`Resend refused the message: ${error.message}`);
    }
  }
}

/** One instance per process; the Resend client holds a keep-alive agent. */
const globalForMailer = globalThis as unknown as { __openingsMailer?: Mailer };

export function getMailer(): Mailer {
  return (globalForMailer.__openingsMailer ??= serverEnv.RESEND_API_KEY
    ? new ResendMailer(new Resend(serverEnv.RESEND_API_KEY))
    : new ConsoleMailer());
}
