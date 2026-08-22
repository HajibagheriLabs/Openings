import { z } from "zod";

/**
 * THE URL IS THE STATE.
 *
 * Every choice a visitor makes on the booking page — the service, the staff
 * member, the date, the month the calendar is showing — lives in the query
 * string and nowhere else. There is no wizard reducer, no context, no session.
 * That single decision buys four things at once:
 *
 *   - a step is shareable. "Book me in here" plus a link is a whole message.
 *   - a refresh keeps the choice, including on a phone that backgrounded the
 *     tab for ten minutes.
 *   - the back button behaves, because going back IS going to the previous
 *     step's URL.
 *   - every step can be a Server Component. The data for a step is a function
 *     of the URL, so choosing a service is a navigation, not a fetch — and
 *     steps 1 and 2 ship no client JavaScript at all.
 *
 * Nothing here throws. A stale link, a hand-edited parameter and a service
 * that was deleted this morning all resolve the same way: the unusable part is
 * dropped and the visitor lands on the earliest step that still makes sense.
 * Refusing a link with an error would be technically defensible and useless to
 * somebody standing outside a salon.
 */

/** Query parameter names, in one place so the page and the links agree. */
export const BOOKING_PARAM = {
  service: "service",
  staff: "staff",
  date: "date",
  month: "month",
} as const;

/**
 * The staff value meaning "whoever is free".
 *
 * A real value rather than an absent parameter, because "I have not chosen
 * yet" and "I chose to let you decide" are different states: the first has to
 * show the staff step, the second has to skip past it.
 */
export const ANY_STAFF = "any";

/** "2026-09-03" — a LOCAL calendar date in the business's timezone. */
export const LOCAL_DATE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/** "2026-09" — the month the calendar is showing. */
export const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

const serviceSchema = z.uuid();
const staffSchema = z.union([z.literal(ANY_STAFF), z.uuid()]);
const dateSchema = z.string().regex(LOCAL_DATE_PATTERN);
const monthSchema = z.string().regex(MONTH_PATTERN);

export interface BookingQuery {
  /** A service id, or null when the visitor has not chosen one. */
  service: string | null;
  /** A staff id, `ANY_STAFF`, or null when the visitor has not chosen. */
  staff: string | null;
  /** A local date in the business timezone, or null. */
  date: string | null;
  /**
   * Which month the calendar is showing. Navigation only — it selects
   * nothing. Defaults to the month of `date`, and then to the current month
   * in the business's zone.
   */
  month: string | null;
}

/** Next hands repeated parameters through as arrays. Take the first. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parse<T>(schema: z.ZodType<T>, value: string | string[] | undefined) {
  const single = first(value);

  if (single === undefined) {
    return null;
  }

  const result = schema.safeParse(single);

  return result.success ? result.data : null;
}

/**
 * `searchParams` to a validated query. Shape only — whether the service
 * actually exists is the page's question, asked against the database.
 */
export function parseBookingQuery(
  raw: Record<string, string | string[] | undefined>,
): BookingQuery {
  return {
    service: parse(serviceSchema, raw[BOOKING_PARAM.service]),
    staff: parse(staffSchema, raw[BOOKING_PARAM.staff]),
    date: parse(dateSchema, raw[BOOKING_PARAM.date]),
    month: parse(monthSchema, raw[BOOKING_PARAM.month]),
  };
}

/**
 * A booking URL from an explicit, complete state.
 *
 * Callers pass the whole state they intend rather than a patch, so dropping
 * what a change invalidates is impossible to forget: a link that changes the
 * service simply does not mention a staff member or a date, and the visitor
 * cannot end up holding a Tuesday that belonged to a service they are no
 * longer booking.
 *
 * Empty parameters are omitted, so step one is a bare `/book/rosas-hair-studio`
 * and the address stays legible all the way through.
 */
export function bookingUrl(
  slug: string,
  state: Partial<BookingQuery> = {},
): string {
  const params = new URLSearchParams();

  for (const key of ["service", "staff", "date", "month"] as const) {
    const value = state[key];

    if (value) {
      params.set(BOOKING_PARAM[key], value);
    }
  }

  const query = params.toString();

  return query ? `/book/${slug}?${query}` : `/book/${slug}`;
}
