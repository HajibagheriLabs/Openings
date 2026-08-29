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

/**
 * The single calendar part a message may carry.
 *
 * SINGULAR, AND THAT IS THE RULE. One `text/calendar` part, with its `method`
 * in the content type, is what makes Gmail, Apple Mail and Outlook render an
 * invitation with buttons on it. Add a second attachment of any kind and most
 * of them fall back to a paperclip and a file, which is not an invitation at
 * all. See src/lib/notifications/invite.ts.
 */
export interface CalendarPart {
  /** `invite.ics`. */
  filename: string;
  /** `text/calendar; charset=utf-8; method=REQUEST` — the method is required. */
  contentType: string;
  /** The iCalendar text itself. */
  content: string;
}

export interface OutboundEmail {
  /** A single recipient. Transactional mail here never has more. */
  to: string;
  subject: string;
  html: string;
  /** Plain-text alternative. Never optional — it is what spam filters read. */
  text: string;
  /** An invitation or a cancellation, for the messages that carry one. */
  calendar?: CalendarPart | null;
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
        /* The .ics is printed in full, never summarised. It is the part of a
           booking product that is hardest to eyeball and easiest to get subtly
           wrong, and somebody running without an email provider should be able
           to read the UID and the SEQUENCE straight out of their terminal. */
        ...(email.calendar
          ? [
              "",
              `──── ${email.calendar.filename} (${email.calendar.contentType}) ────`,
              email.calendar.content.trimEnd(),
            ]
          : []),
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
      /* At most ONE, ever. `contentType` carries the `method=` parameter,
         which is what separates an invitation from a file. */
      ...(email.calendar
        ? {
            attachments: [
              {
                filename: email.calendar.filename,
                content: Buffer.from(email.calendar.content, "utf8"),
                contentType: email.calendar.contentType,
              },
            ],
          }
        : {}),
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
