import {
  LOCAL_DATE_PATTERN,
  STREAM_KEEPALIVE_MS,
  STREAM_MAX_LIFETIME_MS,
  STREAM_TICK_MS,
  type AgendaChange,
  type AgendaStreamEvent,
} from "@/lib/admin/calendar";
import { getOwnedBusiness, getUser } from "@/lib/auth-server";
import { localDateOf } from "@/lib/scheduling/local-minutes";
import {
  loadAgendaSnapshot,
  type AgendaSnapshotRow,
} from "@/server/queries/agenda";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE OWNER'S LIVE AGENDA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS VIEW GETS A STREAM WHEN THE PUBLIC PICKER GETS A POLL, said once
 * more here because this is the file that costs the money:
 *
 * A serverless function held open for a stream is billed for as long as it is
 * open. The public booking page is read by EVERYBODY — fifty people idly
 * browsing a Saturday would be fifty pinned instances doing nothing, and they
 * would not even be buying anything: a customer's slot is protected by a real
 * `held` row that the exclusion constraint enforces from the instant they tap,
 * so hearing about somebody else's booking in fifteen milliseconds instead of
 * fifteen seconds changes nothing that can be lost. That page polls
 * (POLL_INTERVAL_MS in src/lib/booking/hold.ts).
 *
 * This page is read by ONE PERSON PER BUSINESS, who leaves it open on the
 * counter all day, and for whom staleness is a real failure: a booking that
 * lands while they are on the phone has to appear, or they will double-book by
 * hand. One connection per owner is a cost a business can carry, and freshness
 * here is the product rather than a garnish.
 *
 * ═══ WHAT IS ACTUALLY ON THE WIRE ═══
 *
 * A DOORBELL, NOT A DATA FEED. Postgres is not pushing anything — there is no
 * LISTEN/NOTIFY and no trigger — so this connection re-reads a narrow, indexed
 * snapshot every few seconds and DIFFS IT AGAINST WHAT IT LAST SAW. When
 * something moved it emits what changed, in words, and the browser re-renders
 * the Server Component to get the truth. The agenda is never patched from this
 * payload, because a payload that could draw the calendar would be a second
 * implementation of the calendar.
 *
 * ═══ IT RETIRES ITSELF ═══
 *
 * A stream that runs until the platform's wall clock kills it produces a torn
 * connection and an error in the log. This one says goodbye first, and the
 * client reconnects immediately — see STREAM_MAX_LIFETIME_MS.
 */
export const runtime = "nodejs";

/* Never cached, never prerendered — and `no-transform` below matters as much:
   a proxy that gzips or buffers an event stream turns it into a very slow
   download that delivers nothing until it ends. */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  /**
   * THE SAME GATE AS EVERY OWNER PAGE, and it runs before a single byte of
   * stream is opened. `getUser` rather than `requireUser`: a redirect is the
   * right answer for a browser navigating to a page and the wrong one for an
   * EventSource, which would follow it and then fail to parse a sign-in form
   * as events. A 401 is a fact the client can act on.
   */
  const user = await getUser();

  if (!user) {
    return new Response("Not signed in.", { status: 401 });
  }

  const business = await getOwnedBusiness(user.id);

  if (!business) {
    return new Response("No business.", { status: 404 });
  }

  const url = new URL(request.url);
  const today = localDateOf(new Date(), business.timezone);

  /* The window to watch, as LOCAL dates in the business's zone. A bad value is
     replaced with today rather than argued with — this endpoint's job is to
     stay connected, not to validate a form. */
  const from = validDate(url.searchParams.get("from")) ?? today;
  const to = validDate(url.searchParams.get("to")) ?? from;

  const encoder = new TextEncoder();
  const timeZone = business.timezone;
  const businessId = business.id;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const send = (event: AgendaStreamEvent) => {
        if (closed) {
          return;
        }

        try {
          controller.enqueue(
            encoder.encode(
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            ),
          );
        } catch {
          /* The client went away between the check and the write. Nothing to
             report and nowhere to report it. */
          closed = true;
        }
      };

      const comment = (text: string) => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(`: ${text}\n\n`));
          } catch {
            closed = true;
          }
        }
      };

      /* `retry` tells the browser's own EventSource how long to wait before
         reconnecting if this connection drops in a way our client code never
         sees. The client has its own backoff on top; this is the floor. */
      controller.enqueue(encoder.encode("retry: 3000\n\n"));

      /**
       * The baseline.
       *
       * Read BEFORE the first tick and never announced: everything already in
       * the diary when the owner opened the page is on the page. Announcing it
       * would greet them with a toast for every appointment they can already
       * see.
       */
      let previous = index(
        await loadAgendaSnapshot(businessId, from, to, timeZone).catch(
          () => [] as AgendaSnapshotRow[],
        ),
      );

      send({ type: "hello", serverNow: new Date().toISOString() });

      const timers: ReturnType<typeof setInterval>[] = [];

      const shutdown = () => {
        if (closed) {
          return;
        }

        closed = true;
        timers.forEach(clearInterval);

        try {
          controller.close();
        } catch {
          /* Already closed by the runtime. */
        }
      };

      /* The browser navigated away, or the tab was closed. Stop the timers
         immediately rather than discovering it on the next failed write. */
      request.signal.addEventListener("abort", shutdown);

      timers.push(
        setInterval(async () => {
          if (closed) {
            return;
          }

          try {
            const current = index(
              await loadAgendaSnapshot(businessId, from, to, timeZone),
            );

            const changes = diff(previous, current, timeZone);
            previous = current;

            if (changes.length > 0) {
              send({
                type: "change",
                serverNow: new Date().toISOString(),
                changes,
              });
            }
          } catch (error) {
            /**
             * A failed tick says nothing.
             *
             * The agenda on screen is the last truth we had, and a database
             * blip is not news the owner can act on. The connection stays up
             * and the next tick tries again; if the connection itself dies the
             * client's backoff takes over.
             */
            console.error("[agenda-stream] tick failed", error);
          }
        }, STREAM_TICK_MS),
      );

      /* Keeps intermediaries from deciding a quiet connection is a dead one.
         A comment frame is ignored by EventSource and costs three bytes. */
      timers.push(
        setInterval(() => comment("keep-alive"), STREAM_KEEPALIVE_MS),
      );

      timers.push(
        setInterval(() => {
          send({ type: "bye", reason: "lifetime" });
          shutdown();
        }, STREAM_MAX_LIFETIME_MS),
      );
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      /* Nginx, and anything else that honours it, must not buffer this. */
      "X-Accel-Buffering": "no",
    },
  });
}

function validDate(value: string | null): string | null {
  return value && LOCAL_DATE_PATTERN.test(value) ? value : null;
}

function index(rows: AgendaSnapshotRow[]): Map<string, AgendaSnapshotRow> {
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * What altered between two readings, in the words a toast will use.
 *
 * The wording is composed HERE, on the server, because it contains a time and
 * a time has to be formatted in the business's zone. The client formats
 * instants happily; it is not asked to decide which zone a sentence is about.
 *
 * A hold appearing is reported as well as a booking. It is quieter — "somebody
 * is choosing 3:30pm" — but an owner about to promise that slot down the phone
 * is entitled to know it is being looked at.
 */
function diff(
  previous: Map<string, AgendaSnapshotRow>,
  current: Map<string, AgendaSnapshotRow>,
  timeZone: string,
): AgendaChange[] {
  const changes: AgendaChange[] = [];

  for (const [id, row] of current) {
    const before = previous.get(id);
    const at = shortTime(row.startsAt, timeZone);
    const who = row.customerName ?? row.staffName;

    if (!before) {
      if (row.status === "confirmed") {
        changes.push({
          kind: "booked",
          appointmentId: id,
          label: `New booking — ${at}, ${who}`,
          startsAt: row.startsAt,
        });
      } else if (row.status === "held") {
        changes.push({
          kind: "held",
          appointmentId: id,
          label: `Someone is booking ${at}`,
          startsAt: row.startsAt,
        });
      }

      continue;
    }

    if (before.startsAt !== row.startsAt) {
      changes.push({
        kind: "moved",
        appointmentId: id,
        label: `Moved to ${at} — ${who}`,
        startsAt: row.startsAt,
      });

      continue;
    }

    if (before.status === row.status) {
      continue;
    }

    if (row.status === "cancelled") {
      changes.push({
        kind: "cancelled",
        appointmentId: id,
        label: `Cancelled — ${at}, ${who}`,
        startsAt: row.startsAt,
      });
    } else if (before.status === "held" && row.status === "confirmed") {
      changes.push({
        kind: "booked",
        appointmentId: id,
        label: `New booking — ${at}, ${who}`,
        startsAt: row.startsAt,
      });
    } else {
      changes.push({
        kind: "status",
        appointmentId: id,
        label: `${at} — ${who} is now ${readable(row.status)}`,
        startsAt: row.startsAt,
      });
    }
  }

  /* A row that VANISHED was an expired hold being swept, which is the one
     change nobody needs a toast about — the slot simply comes back and the
     re-render shows it. It still counts as a change, so the agenda refreshes. */
  for (const [id, row] of previous) {
    if (!current.has(id)) {
      changes.push({
        kind: "status",
        appointmentId: id,
        label: `A hold on ${shortTime(row.startsAt, timeZone)} expired`,
        startsAt: row.startsAt,
      });
    }
  }

  return changes;
}

/** "3:30pm". Formatting an instant in a zone — never arithmetic. */
function shortTime(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(new Date(instant))
    .replace(/\s/g, "")
    .toLowerCase();
}

function readable(status: string): string {
  return status === "no_show" ? "a no-show" : status;
}
