import { cn } from "@/lib/utils";

/**
 * The only place an instant becomes something a person reads.
 *
 * The server sends ISO instants plus the business's IANA timezone. This
 * formats them with Intl.DateTimeFormat and does no arithmetic whatsoever —
 * no adding, no subtracting, no "start plus duration". If a component seems to
 * need that, the server should have sent the second instant too.
 *
 * In this product a time is a headline, so everything here is set in Epilogue
 * with tabular figures: 09:00 and 10:00 occupy exactly the same width, and a
 * column of times lines up instead of shimmering.
 */

/**
 * Pinned, not the visitor's locale.
 *
 * A Server Component and the browser that hydrates it must produce byte-identical
 * text or React tears the tree down and re-renders it. `undefined` resolves to
 * the server's locale on one side and the visitor's on the other, so the two
 * disagree the moment a customer in the US opens a page rendered in Frankfurt.
 * Pass `locale` explicitly when a surface genuinely wants the visitor's own
 * conventions, and render that surface on the client.
 */
export const DEFAULT_TIME_LOCALE = "en-GB";

const HHMM: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

/** One instant, formatted in one timezone. */
export function formatInstant(
  instant: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = HHMM,
  locale: string = DEFAULT_TIME_LOCALE,
): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(
    new Date(instant),
  );
}

/** "09:30 – 10:15". Two instants the server already worked out. */
export function formatInstantRange(
  startsAt: string,
  endsAt: string,
  timeZone: string,
  locale: string = DEFAULT_TIME_LOCALE,
): string {
  return `${formatInstant(startsAt, timeZone, HHMM, locale)} – ${formatInstant(
    endsAt,
    timeZone,
    HHMM,
    locale,
  )}`;
}

/** "Thursday, 20 August". */
export function formatInstantDate(
  instant: string,
  timeZone: string,
  locale: string = DEFAULT_TIME_LOCALE,
): string {
  return formatInstant(
    instant,
    timeZone,
    { weekday: "long", day: "numeric", month: "long" },
    locale,
  );
}

/**
 * "45 min", "1 hr", "1 hr 30 min".
 *
 * Minutes are a count, not a clock, so this is plain division — the one piece
 * of arithmetic in the module and the one that cannot be wrong about a
 * timezone.
 */
export function formatDuration(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/**
 * The short zone name a visitor recognises — "CEST" rather than
 * "Europe/Berlin". Falls back to the identifier if the runtime has no name
 * for it.
 */
export function formatTimeZoneAbbreviation(
  instant: string,
  timeZone: string,
  locale: string = DEFAULT_TIME_LOCALE,
): string {
  const part = new Intl.DateTimeFormat(locale, {
    timeZone,
    timeZoneName: "short",
  })
    .formatToParts(new Date(instant))
    .find((candidate) => candidate.type === "timeZoneName");

  return part?.value ?? timeZone;
}

export type TimeTextSize = "time" | "time-lg";

export function TimeText({
  instant,
  timeZone,
  locale,
  options,
  size = "time",
  className,
  ...props
}: {
  /** ISO instant from the server. */
  instant: string;
  /** IANA identifier, e.g. "Europe/Berlin". Never an offset. */
  timeZone: string;
  locale?: string;
  options?: Intl.DateTimeFormatOptions;
  size?: TimeTextSize;
} & Omit<React.ComponentProps<"time">, "children">) {
  return (
    <time
      dateTime={instant}
      className={cn(
        size === "time-lg" ? "type-time-lg" : "type-time",
        className,
      )}
      {...props}
    >
      {formatInstant(instant, timeZone, options, locale)}
    </time>
  );
}
