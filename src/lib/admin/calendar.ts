/**
 * The calendar's vocabulary, shared by the page, the navigator and the stream.
 *
 * NO `server-only`. The client components import these types to type their
 * props and their fetches, and the server imports the same ones to type what
 * it returns — which is the only way the two stay in step.
 *
 * NOTHING HERE COMPUTES A DATE. Moving a day forward, working out which Monday
 * a week starts on, and deciding what "today" means in the business's timezone
 * are all calendar arithmetic, and they all happen on the server with Temporal.
 * What lives here is the shape of the URL and the shape of the events.
 */

import type { RibbonColumn } from "@/components/ribbon";
import type { AgendaAppointment, DaySummary } from "@/lib/scheduling/agenda";

/** "2026-08-29". A local calendar date in the business's zone. */
export const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * How long an unbooked stretch has to be before it is worth naming.
 *
 * IT LIVES HERE RATHER THAN WITH THE SUMMARY THAT USES IT, and the reason is a
 * module boundary. `src/lib/scheduling/agenda.ts` reaches Temporal, which is
 * `server-only`, so a Client Component may import its TYPES (erased at build
 * time) but never a value from it. The Today panel puts this number in a
 * heading, so the number has to be somewhere the browser can reach — which is
 * exactly what this module is for.
 */
export const GAP_THRESHOLD_MIN = 30;

export type CalendarView = "day" | "week";

export function isCalendarView(value: unknown): value is CalendarView {
  return value === "day" || value === "week";
}

/** What the calendar page reads out of the URL. */
export interface CalendarParams {
  view: CalendarView;
  /** Local date. The day being shown, or a day inside the week being shown. */
  date: string;
  /** A staff id, or null for everybody. */
  staffId: string | null;
}

/**
 * The URL for a calendar state.
 *
 * The view is in the URL rather than in component state on purpose: an owner
 * who lands on a booking from an email, then moves to the week, then reloads,
 * should still be looking at the week. It also makes every control on the
 * navigator an ordinary link, which is what makes them work with a middle
 * click and with the back button.
 */
export function calendarHref(params: Partial<CalendarParams>): string {
  const search = new URLSearchParams();

  if (params.view && params.view !== "day") {
    search.set("view", params.view);
  }
  if (params.date) {
    search.set("date", params.date);
  }
  if (params.staffId) {
    search.set("staff", params.staffId);
  }

  const query = search.toString();

  return query ? `/admin/calendar?${query}` : "/admin/calendar";
}

/* ===========================================================================
   What the page hands the client
   =========================================================================== */

export interface CalendarStaffOption {
  id: string;
  name: string;
  initials: string;
}

export interface CalendarServiceOption {
  id: string;
  name: string;
  durationMin: number;
  priceCents: number;
  /** Who may perform it. Empty means nobody is assigned yet. */
  staffIds: string[];
}

/** Everything the detail sheet shows about one appointment. */
export interface AppointmentDetail {
  id: string;
  status: AgendaAppointment["status"];
  startsAt: string;
  endsAt: string;
  serviceName: string;
  staffName: string;
  priceCents: number;
  depositCents: number;
  /** Set once a payment intent exists — the deposit really was charged. */
  depositPaid: boolean;
  refundedCents: number | null;
  customer: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
  } | null;
  customerNote: string | null;
  internalNote: string | null;
  /** True when the owner typed this booking in rather than a customer making it. */
  createdByOwner: boolean;
  cancelledBy: "customer" | "business" | null;
  cancellationReason: string | null;
}

/* ===========================================================================
   THE SSE CONTRACT
   ---------------------------------------------------------------------------
   ═══ WHY THIS VIEW GETS A STREAM AND THE PUBLIC PICKER GETS A POLL ═══

   It is one number: CONNECTIONS PER USEFUL VIEWER.

   The public picker is read by everybody who ever looks at the booking page. On
   a serverless runtime a stream is a function instance pinned open for as long
   as somebody is looking, billed by the second — so fifty people idly browsing
   a Saturday is fifty pinned instances doing nothing. And it would not even be
   buying what people assume: a customer's slot is protected by a real `held`
   row that the exclusion constraint enforces, not by being told quickly. Being
   told within fifteen seconds instead of fifteen milliseconds changes nothing
   that can be lost. See POLL_INTERVAL_MS in src/lib/booking/hold.ts.

   This view is read by ONE PERSON PER BUSINESS, who leaves it open on a counter
   all day and genuinely needs it to be true — a booking that lands while they
   are looking at the screen has to appear, or they will double-book by hand
   over the phone. One connection per owner is a cost a business can carry, and
   the freshness is the product.

   So: SSE here, polling there. Same product, opposite answers, and the reason
   is the ratio of connections to value rather than a preference for either
   mechanism.
   =========================================================================== */

/** The route the owner's agenda subscribes to. */
export const AGENDA_STREAM_PATH = "/api/admin/agenda/stream";

/**
 * How often the stream re-reads the window on the server.
 *
 * Postgres has no push here — there is no LISTEN/NOTIFY and no trigger — so
 * the connection is long-lived and the QUERY behind it is short and indexed
 * (`appointments_business_id_starts_at_idx`). Four seconds is comfortably
 * faster than a person can walk from the phone to the counter, and it is one
 * query per owner rather than one per viewer.
 */
export const STREAM_TICK_MS = 4_000;

/**
 * How long a single connection is allowed to live before it retires itself.
 *
 * Serverless functions have a wall clock, and a stream that runs until the
 * platform kills it produces a torn connection and an error in the log. Ending
 * it deliberately, with a `bye` the client understands, turns that into a
 * planned reconnect: the client comes straight back, the server-side query
 * starts fresh, and nothing in between looks like a failure.
 */
export const STREAM_MAX_LIFETIME_MS = 5 * 60_000;

/** A comment frame often enough that no proxy decides the connection is dead. */
export const STREAM_KEEPALIVE_MS = 20_000;

/**
 * Reconnect backoff, in milliseconds, then the last value repeats.
 *
 * Starts fast because the overwhelmingly likely cause of a drop is the planned
 * retirement above, and ends slow because the other cause is the business's
 * wifi being out, where hammering a dead endpoint helps nobody.
 */
export const STREAM_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * Consecutive failures before the agenda stops trusting the stream and starts
 * polling instead.
 *
 * THE FALLBACK IS NOT A SECOND IMPLEMENTATION. It refreshes the same Server
 * Component the stream's `change` event refreshes; the only difference is what
 * decides when. A corporate proxy that buffers `text/event-stream` into
 * uselessness is a real thing, and an agenda that silently stops updating is
 * worse than one that updates slowly.
 */
export const STREAM_FAILURES_BEFORE_POLLING = 3;

/** How often the fallback re-reads the agenda once the stream has given up. */
export const STREAM_POLL_FALLBACK_MS = 30_000;

/** What happened to one appointment between two ticks. */
export interface AgendaChange {
  kind: "booked" | "cancelled" | "held" | "moved" | "status";
  appointmentId: string;
  /** Ready to read: "3:30pm, Anna". Composed on the server, in its zone. */
  label: string;
  startsAt: string;
}

/**
 * A frame on the wire.
 *
 * `hello` lands on connect and carries the server's clock, so a client that
 * has been asleep can tell how stale it is. `change` carries only what altered
 * — the agenda itself is re-rendered from the server, never patched from this
 * payload, because the payload is a notification and the database is the truth.
 * `bye` is the planned retirement above.
 */
export type AgendaStreamEvent =
  | { type: "hello"; serverNow: string }
  | { type: "change"; serverNow: string; changes: AgendaChange[] }
  | { type: "bye"; reason: "lifetime" };

/** What the Today panel is handed. */
export interface TodayPanelData {
  summary: DaySummary;
  /** The day's appointments in start order, holds included. */
  appointments: AgendaAppointment[];
  currency: string;
  timeZone: string;
}

/** The day view, ready to draw. */
export interface CalendarDayData {
  date: string;
  dayInstant: string;
  window: { startMinute: number; endMinute: number };
  nowMinute: number | null;
  columns: RibbonColumn[];
}
