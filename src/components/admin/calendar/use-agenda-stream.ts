"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  AGENDA_STREAM_PATH,
  STREAM_BACKOFF_MS,
  STREAM_FAILURES_BEFORE_POLLING,
  STREAM_POLL_FALLBACK_MS,
  type AgendaStreamEvent,
} from "@/lib/admin/calendar";

/**
 * The owner's agenda, kept true while they look at it.
 *
 * ═══ WHAT ARRIVES AND WHAT IS DRAWN ARE NOT THE SAME THING ═══
 *
 * The stream is a DOORBELL. When it says something changed, this hook calls
 * `router.refresh()` and the Server Component re-renders from the database —
 * so the calendar on screen is always something the server drew, never
 * something the browser patched together from an event payload. That is what
 * keeps one implementation of the agenda instead of two, and it is why the
 * event carries a sentence for a toast rather than an appointment.
 *
 * `router.refresh()` also preserves client state: an open detail sheet stays
 * open, a half-typed note stays typed, and the ribbon does not jump back to
 * the top. A hard reload would lose all three.
 *
 * ═══ IT NEVER JUST STOPS ═══
 *
 * Three things end a connection, and only one of them is a problem:
 *
 *   `bye`     the server retiring a connection before the platform kills it.
 *             Reconnect immediately; nothing went wrong.
 *   `error`   a real drop. Reconnect on a backoff that starts fast and ends
 *             slow, because the likely causes are a redeploy (back in a
 *             second) and the shop's wifi being out (back in a while).
 *   giving up after STREAM_FAILURES_BEFORE_POLLING consecutive failures, the
 *             hook stops trusting the stream and POLLS instead — the same
 *             `router.refresh()`, on a timer. Corporate proxies that buffer
 *             `text/event-stream` into uselessness are real, and an agenda
 *             that silently stopped updating would be worse than a slow one.
 *             It keeps trying the stream in the background and returns to it
 *             the moment one connects.
 */

export type AgendaStreamStatus = "connecting" | "live" | "polling";

export function useAgendaStream({
  from,
  to,
  enabled = true,
}: {
  /** Local dates in the business's timezone. The window being watched. */
  from: string;
  to: string;
  enabled?: boolean;
}): AgendaStreamStatus {
  /**
   * `router` is a dependency of the effect below, and that is safe: the App
   * Router hands back a stable object, so this effect runs when the WINDOW
   * changes and not on every render. It matters, because re-running it tears
   * the connection down and opens a new one — a live connection that rebuilds
   * itself on each render is a request storm with a heartbeat.
   */
  const router = useRouter();
  const [status, setStatus] = useState<AgendaStreamStatus>("connecting");

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let source: EventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let failures = 0;
    let stopped = false;

    const stopPolling = () => {
      if (poll) {
        clearInterval(poll);
        poll = null;
      }
    };

    const startPolling = () => {
      if (poll) {
        return;
      }

      setStatus("polling");
      poll = setInterval(() => router.refresh(), STREAM_POLL_FALLBACK_MS);
    };

    const backoffFor = (attempt: number) =>
      STREAM_BACKOFF_MS[Math.min(attempt, STREAM_BACKOFF_MS.length - 1)];

    const scheduleReconnect = (delay: number) => {
      if (stopped) {
        return;
      }

      reconnect = setTimeout(connect, delay);
    };

    function connect() {
      if (stopped) {
        return;
      }

      const url = `${AGENDA_STREAM_PATH}?from=${encodeURIComponent(
        from,
      )}&to=${encodeURIComponent(to)}`;

      source = new EventSource(url);

      source.addEventListener("hello", () => {
        failures = 0;
        stopPolling();
        setStatus("live");
      });

      source.addEventListener("change", (event) => {
        const parsed = parse(event);

        if (parsed?.type !== "change" || parsed.changes.length === 0) {
          return;
        }

        announce(parsed.changes.map((change) => change.label));

        /* The truth comes from the server, not from the payload above. */
        router.refresh();
      });

      source.addEventListener("bye", () => {
        /* Planned retirement. Not a failure, so the backoff is not advanced
           and the connection comes straight back. */
        source?.close();
        source = null;
        scheduleReconnect(250);
      });

      source.onerror = () => {
        source?.close();
        source = null;

        failures += 1;

        if (failures >= STREAM_FAILURES_BEFORE_POLLING) {
          startPolling();
        } else {
          setStatus("connecting");
        }

        scheduleReconnect(backoffFor(failures));
      };
    }

    connect();

    return () => {
      stopped = true;
      source?.close();

      if (reconnect) {
        clearTimeout(reconnect);
      }

      stopPolling();
    };
  }, [from, to, enabled, router]);

  return status;
}

function parse(event: Event): AgendaStreamEvent | null {
  try {
    return JSON.parse((event as MessageEvent<string>).data) as AgendaStreamEvent;
  } catch {
    return null;
  }
}

/**
 * The quiet toast.
 *
 * ONE TOAST, HOWEVER MANY CHANGES. A tick that catches three bookings at once
 * — an import, a burst on a Saturday morning, a reconnect after a minute
 * offline — must not stack three notifications on top of the calendar the
 * owner is trying to read. The first one is named because a name is what makes
 * it actionable; the rest are counted.
 */
function announce(labels: string[]): void {
  toast(labels[0], {
    description:
      labels.length > 1
        ? `And ${labels.length - 1} more change${labels.length > 2 ? "s" : ""}.`
        : undefined,
  });
}
