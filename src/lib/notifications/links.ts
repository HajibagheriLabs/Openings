/**
 * Every URL that appears in a transactional email, built from an explicit
 * origin.
 *
 * PURE ON PURPOSE — no `server-only`, no configuration read. The origin is an
 * argument rather than a module-level lookup so the templates can be rendered
 * and asserted in a test without a configured environment, and so one message
 * cannot end up carrying links to two different hosts.
 */

/** The query parameter carrying the manage token. Short, because it is typed. */
export const MANAGE_TOKEN_PARAM = "t";

/**
 * Join an origin and a path.
 *
 * A trailing slash on the configured origin would produce `//manage`, which
 * some clients silently rewrite and others treat as a protocol-relative URL.
 * Trimmed here, once, rather than in every caller.
 */
export function absoluteUrl(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, "")}${path}`;
}

/** Where the customer goes to see, move or cancel their appointment. */
export function manageUrl(
  origin: string,
  appointmentId: string,
  manageToken: string,
): string {
  return absoluteUrl(
    origin,
    `/manage/${appointmentId}?${MANAGE_TOKEN_PARAM}=${encodeURIComponent(
      manageToken,
    )}`,
  );
}

/**
 * The hosted copy of the invite.
 *
 * A FALLBACK THAT EARNS ITS PLACE. Calendar attachments are handled well by
 * Apple Mail and Outlook, adequately by Gmail on the web, and erratically by
 * everything else — a webmail that decides the .ics is a file offers a
 * download rather than an invitation, and a phone that cannot open a
 * downloaded file offers nothing at all. A plain https link returning the same
 * bytes as `text/calendar` works in every one of those cases.
 */
export function icsUrl(
  origin: string,
  appointmentId: string,
  manageToken: string,
): string {
  return absoluteUrl(
    origin,
    `/ics/${appointmentId}?${MANAGE_TOKEN_PARAM}=${encodeURIComponent(
      manageToken,
    )}`,
  );
}

/** "20260903T120000Z" — the compact UTC form Google's template URL wants. */
function googleStamp(instant: Date): string {
  return instant.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * A Google Calendar "add event" link.
 *
 * The SECOND fallback, and deliberately a different kind of thing from the
 * .ics: it is not an invitation, it carries no UID and no sequence, and using
 * it creates an event Google owns rather than one the business can later
 * update. That is a real limitation, and it is why this is offered third
 * rather than first. What it buys is the one case the other two miss entirely
 * — somebody reading on a phone whose mail app will not hand an attachment to
 * a calendar, but which opens links perfectly well.
 *
 * The instants are written in UTC, so no timezone parameter is needed and no
 * client has to agree with us about what "Europe/Berlin" meant on that date.
 */
export function googleCalendarUrl(event: {
  title: string;
  startsAt: Date;
  endsAt: Date;
  details: string;
  location?: string | null;
}): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates: `${googleStamp(event.startsAt)}/${googleStamp(event.endsAt)}`,
    details: event.details,
  });

  if (event.location) {
    params.set("location", event.location);
  }

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
