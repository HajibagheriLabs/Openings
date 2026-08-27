"use client";

import { CalendarOff, List, Rows3 } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { BookingShell } from "@/components/booking/booking-shell";
import { SlotList } from "@/components/booking/slot-list";
import { StepHeading } from "@/components/booking/step-heading";
import {
  formatCountdown,
  useHoldCountdown,
} from "@/components/booking/use-hold-countdown";
import { PillButton } from "@/components/pill-button";
import {
  Ribbon,
  RibbonLegend,
  type RibbonSegment,
} from "@/components/ribbon";
import {
  formatDuration,
  formatInstant,
  formatInstantDate,
  formatInstantRange,
} from "@/components/time-text";
import {
  POLL_INTERVAL_MS,
  type HoldSnapshot,
  type PickerSnapshot,
} from "@/lib/booking/hold";
import { formatCents } from "@/lib/money";
import type { DayOffer } from "@/lib/scheduling/day-view";
import { cn } from "@/lib/utils";
import { refreshDay, releaseSlot, takeSlot } from "@/server/actions/booking";

/**
 * Step 4 — the time, and the hold that comes with it.
 *
 * TAPPING A TIME WRITES A ROW. Not a flag in this component's state, not a
 * "pending" badge — an `appointments` row with status `held` and a deadline
 * computed by Postgres, covered by the exclusion constraint, which makes the
 * slot genuinely unavailable to every other visitor from that millisecond on.
 * Everything visible here is a report on that row: the depleting bar is its
 * remaining time, the countdown is its deadline, and when it goes the customer
 * is told rather than discovering it at checkout.
 *
 * THE COMPONENT NEVER DECIDES WHAT THE DAY LOOKS LIKE. Every server round trip
 * — taking, releasing, polling, losing a race — returns a whole fresh
 * `PickerSnapshot`, and this replaces its state with it wholesale. There is no
 * optimistic patching and no local model of availability to drift out of date,
 * which is what makes the fifteen-second poll the ONLY window in which the
 * drawing can be stale.
 */

/**
 * Where a tab parks "I was holding this" across a reload. sessionStorage, not
 * localStorage: the note has to die with the tab, or a second window would
 * resurrect a slot the visitor gave up an hour ago.
 */
const RESUME_KEY = "openings.resume-hold";

interface TimeStepService {
  id: string;
  name: string;
  durationMin: number;
  priceCents: number;
  /** "£15 deposit, £45 on the day", or null. */
  depositLine: string | null;
}

export function TimeStep({
  slug,
  service,
  staffId,
  currency,
  initial,
  initialNotice = null,
  detailsHref,
  step,
  totalSteps,
  header,
  choices,
}: {
  slug: string;
  service: TimeStepService;
  /** The staff id in the URL, or null when the business has one qualified person. */
  staffId: string | null;
  currency: string;
  /** Rendered on the server, so the first paint is already the truth. */
  initial: PickerSnapshot;
  /**
   * One plain sentence about something ordinary that just happened — coming
   * back from an abandoned payment, for instance. Deliberately the same slot
   * the "that time just went" message uses: there is one place on this screen
   * where the product speaks, and it is never a warning triangle.
   */
  initialNotice?: string | null;
  /** Where Continue goes. The hold travels in a cookie, not in this address. */
  detailsHref: string;
  step: number;
  totalSteps: number;
  header: ReactNode;
  choices: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [pendingStart, setPendingStart] = useState<string | null>(null);
  const [view, setView] = useState<"ribbon" | "list">("ribbon");
  const [notice, setNotice] = useState<{
    message: string;
    nearest: DayOffer[];
  } | null>(initialNotice ? { message: initialNotice, nearest: [] } : null);
  /**
   * Start instants that vanished under the visitor, drawn hatched while they
   * fade. Ids rather than offers, because the geometry is recovered from the
   * busy block that replaced them — which is where they now belong.
   */
  const [justTaken, setJustTaken] = useState<string[]>([]);
  const [, startTransition] = useTransition();

  const { day, hold } = snapshot;
  const countdown = useHoldCountdown(hold);

  /**
   * What every action is asked about. Stable for this component's whole life:
   * the day is in the URL, so changing it is a navigation and a fresh mount,
   * never a state update. Memoised so the polling effect below is set up once
   * rather than torn down and rebuilt on every tick of the countdown.
   */
  const request = useMemo(
    () => ({ slug, serviceId: service.id, staffId, date: day.date }),
    [slug, service.id, staffId, day.date],
  );

  /**
   * The offers the visitor can currently see.
   *
   * Kept in a ref and written from an effect, because the comparison below
   * runs inside an event handler rather than during a render — and because a
   * state updater must be PURE. Toasting from inside `setSnapshot(fn)` looked
   * fine and fired twice under StrictMode, which is exactly the bug that rule
   * exists to catch.
   */
  const visibleOfferIds = useRef<Set<string>>(
    new Set(initial.day.offers.map((offer) => offer.id)),
  );

  useEffect(() => {
    visibleOfferIds.current = new Set(day.offers.map((offer) => offer.id));
  }, [day.offers]);

  /** The hold currently on screen, for noticing when one disappears. */
  const visibleHold = useRef<HoldSnapshot | null>(initial.hold);

  useEffect(() => {
    visibleHold.current = hold;
  }, [hold]);

  /**
   * Replace the day, and notice what went while nobody was looking.
   *
   * A vanished offer is only reported as TAKEN if busy time now covers it.
   * Offers also come and go for innocent reasons — the packing is anchored to
   * the slot being held, so choosing a time reshuffles which starts are drawn
   * — and toasting those would cry wolf every time somebody picked a slot.
   */
  const applySnapshot = useCallback(
    (next: PickerSnapshot, options?: { holdEndedDeliberately?: boolean }) => {
    const wasVisible = visibleOfferIds.current;
    const hadHold = visibleHold.current;
    const stillOffered = new Set(next.day.offers.map((offer) => offer.id));

    const lost = next.day.blocks
      .filter((block) => block.kind === "busy")
      .flatMap((block) => {
        const from = Date.parse(block.startsAt);
        const to = Date.parse(block.endsAt);

        return [...wasVisible].filter((id) => {
          if (stillOffered.has(id)) {
            return false;
          }

          const at = Date.parse(id);

          return at >= from && at < to;
        });
      });

    setSnapshot(next);

    /**
     * A HOLD THAT VANISHED WITHOUT ANYBODY ASKING has expired.
     *
     * The countdown usually notices first and says so with the time named. But
     * a poll can land after the deadline and get there first, and a slot that
     * simply stops being highlighted with no explanation is the worst outcome
     * on this screen. Whichever notices, the customer is told.
     */
    if (hadHold && !next.hold && !options?.holdEndedDeliberately) {
      setNotice({
        message: `Your hold on ${formatInstant(
          hadHold.startsAt,
          next.day.timeZone,
        )} ran out. The time is back in the day — take it again if it is still free.`,
        nearest: [],
      });

      /* Sweep the dead row and the stale cookie. The lapsed hold already stops
         blocking anybody — availability ignores it and the next booking
         transaction deletes it — so this is housekeeping, which is why the
         answer is not waited for and a failure changes nothing. */
      void releaseSlot(request);
    }

    if (lost.length === 0) {
      return;
    }

    setJustTaken(lost);

    toast(
      lost.length === 1
        ? `${formatInstant(lost[0], next.day.timeZone)} just went.`
        : `${lost.length} times just went.`,
      { description: "Someone else booked while you were looking." },
    );
  },
    [request],
  );

  /**
   * The ghosts clear themselves.
   *
   * They exist only long enough for the 240ms fade to be seen — leaving them
   * would put a hatched block on top of the real busy material underneath,
   * which is already drawn and already correct.
   */
  useEffect(() => {
    if (justTaken.length === 0) {
      return;
    }

    const timer = setTimeout(() => setJustTaken([]), 1600);

    return () => clearTimeout(timer);
  }, [justTaken]);

  const holding = hold !== null;
  const heldStartsAt = hold?.startsAt ?? null;
  const expired = countdown.expired && holding;
  /* Captured for the message, because releasing clears `hold` before the copy
     that names the time is written. */
  const expiredHold = expired ? hold : null;

  /* ---------------------------------------------------------------------
     Live updates
  --------------------------------------------------------------------- */

  const poll = useCallback(async () => {
    const result = await refreshDay(request);

    if (result.ok) {
      applySnapshot(result.snapshot);
    }
    // A failed poll says nothing. The day on screen is the last truth we had,
    // and a toast every fifteen seconds on a flaky train connection would be
    // worse than a drawing that is briefly a minute old.
  }, [applySnapshot, request]);

  useEffect(() => {
    /**
     * POLL WHILE VISIBLE, STOP WHEN HIDDEN, REFRESH ON THE WAY BACK.
     *
     * See the long note on POLL_INTERVAL_MS for why this is a poll and not a
     * socket. The short version: the hold is what protects the slot, so live
     * updates are a courtesy to somebody who has not chosen yet — and a
     * courtesy is not worth a connection held open per visitor on a serverless
     * runtime. A hidden tab has no viewer at all, so it does not even get the
     * courtesy.
     */
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer === null) {
        timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
      }
    };

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Whatever happened while the tab was in the background happened all
        // at once as far as this page is concerned. Ask immediately.
        void poll();
        start();
      } else {
        stop();
      }
    };

    const onFocus = () => void poll();

    if (document.visibilityState === "visible") {
      start();
    }

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [poll]);

  /* ---------------------------------------------------------------------
     Leaving the page
  --------------------------------------------------------------------- */

  useEffect(() => {
    /**
     * BEST EFFORT, AND NOTHING RESTS ON IT.
     *
     * `sendBeacon` is the only request a browser will reliably still make
     * while a page is being torn down; it posts to a route handler because a
     * Server Action needs headers the beacon API will not let us set. If it
     * never lands — closed laptop, killed tab, lift with no signal — the hold
     * still ends on its deadline, every availability query already ignores a
     * lapsed hold, and every booking transaction deletes colliding expired
     * holds before it writes. This only gives the slot back sooner.
     *
     * DELIBERATELY NOT ON `visibilitychange` → hidden. That fires when
     * somebody switches to their mail app to find the reference number they
     * were asked for, and releasing their slot for it would be actively
     * hostile. `pagehide` is the signal that the page is actually going away,
     * and eight minutes of expiry covers the mobile case where even that never
     * runs.
     */
    const release = () => {
      if (!holding) {
        return;
      }

      /* Leave a note for THIS TAB before letting the slot go. `pagehide`
         cannot tell a reload from a departure, and giving somebody's slot away
         because they pressed refresh would be indefensible — so the intent is
         parked in sessionStorage, which lives exactly as long as the tab does.
         A reload finds it and takes the slot straight back; a closed tab takes
         it with it. */
      sessionStorage.setItem(
        RESUME_KEY,
        JSON.stringify({ ...request, startsAt: heldStartsAt }),
      );

      navigator.sendBeacon?.(
        "/api/book/release",
        new Blob([JSON.stringify({ slug })], { type: "application/json" }),
      );
    };

    window.addEventListener("pagehide", release);
    window.addEventListener("beforeunload", release);

    return () => {
      window.removeEventListener("pagehide", release);
      window.removeEventListener("beforeunload", release);
    };
  }, [slug, holding, heldStartsAt, request]);

  /**
   * Take the slot back after a refresh.
   *
   * Runs once, and only when the server says there is no hold while this tab
   * remembers giving one up on the way out. The re-take goes through the same
   * action as any other, so if somebody took the slot during the reload the
   * customer is told that plainly instead of quietly ending up with nothing.
   */
  const resumed = useRef(false);

  useEffect(() => {
    if (resumed.current) {
      return;
    }

    resumed.current = true;

    const parked = sessionStorage.getItem(RESUME_KEY);
    sessionStorage.removeItem(RESUME_KEY);

    if (!parked || holding) {
      return;
    }

    let intent: { startsAt?: unknown; date?: unknown; serviceId?: unknown };

    try {
      intent = JSON.parse(parked) as typeof intent;
    } catch {
      return;
    }

    /* Only for the same service on the same day. Anything else means the
       visitor has moved on, and re-taking would be taking a decision for
       them. */
    if (
      typeof intent.startsAt !== "string" ||
      intent.date !== request.date ||
      intent.serviceId !== request.serviceId
    ) {
      return;
    }

    const startsAt = intent.startsAt;

    startTransition(async () => {
      const result = await takeSlot({ ...request, startsAt });

      if (result.ok) {
        applySnapshot(result.snapshot);
        return;
      }

      if (result.reason !== "error") {
        applySnapshot(result.snapshot);
        setNotice({ message: result.message, nearest: result.nearest });
      }
    });
  }, [applySnapshot, holding, request]);

  /* ---------------------------------------------------------------------
     Expiry
  --------------------------------------------------------------------- */


  useEffect(() => {
    if (!expired) {
      return;
    }

    const lost = expiredHold;

    /**
     * The hold ran out in front of them.
     *
     * Say so plainly, put the slot back, and leave everything else exactly as
     * it is — the chosen day, the chosen service, the view they were using and
     * anything they have typed all survive, because this only clears the hold.
     * The release call is a courtesy: the deadline already ended the hold, and
     * this just takes the dead row out of the constraint's way sooner.
     */
    startTransition(async () => {
      const result = await releaseSlot(request);

      if (result.ok) {
        // The message below names the time, so the generic one is suppressed.
        applySnapshot(result.snapshot, { holdEndedDeliberately: true });
      } else {
        setSnapshot((current) => ({ ...current, hold: null }));
      }

      setNotice({
        message: lost
          ? `Your hold on ${formatInstant(
              lost.startsAt,
              day.timeZone,
            )} ran out. The time is back in the day — take it again if it is still free.`
          : "Your hold ran out. Pick a time again.",
        nearest: [],
      });
    });
  }, [expired, expiredHold, applySnapshot, day.timeZone, request]);

  /**
   * The one-minute warning.
   *
   * Fired once per hold rather than on every tick — keyed on the appointment
   * id, so moving to a different time arms it again.
   */
  const warnedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!hold || !countdown.warning || warnedFor.current === hold.appointmentId) {
      return;
    }

    warnedFor.current = hold.appointmentId;

    toast.warning("A minute left on your slot", {
      description: `${formatInstant(
        hold.startsAt,
        day.timeZone,
      )} is yours until the countdown runs out.`,
    });
  }, [hold, countdown.warning, day.timeZone]);

  /* ---------------------------------------------------------------------
     Choosing
  --------------------------------------------------------------------- */

  const choose = useCallback(
    (offer: DayOffer) => {
      setNotice(null);

      /* Tapping the slot you are already holding gives it back. The same
         gesture that took it releases it, which is the only mapping that does
         not need explaining. */
      if (hold?.startsAt === offer.startsAt) {
        // Deliberately given up — there is nothing to resume after a reload.
        sessionStorage.removeItem(RESUME_KEY);
        setPendingStart(offer.startsAt);

        startTransition(async () => {
          const result = await releaseSlot(request);

          if (result.ok) {
            applySnapshot(result.snapshot, { holdEndedDeliberately: true });
          }

          setPendingStart(null);
        });

        return;
      }

      setPendingStart(offer.startsAt);

      startTransition(async () => {
        /* One call whether or not they were already holding something. The
           server swaps the two inside a single transaction, so there is no
           moment at which this customer holds both slots or neither. */
        const result = await takeSlot({
          ...request,
          startsAt: offer.startsAt,
        });

        setPendingStart(null);

        if (result.ok) {
          applySnapshot(result.snapshot);
          return;
        }

        if (result.reason === "error") {
          toast.error(result.message);
          return;
        }

        applySnapshot(result.snapshot);
        setNotice({ message: result.message, nearest: result.nearest });
      });
    },
    [applySnapshot, hold, request],
  );

  /* ---------------------------------------------------------------------
     Drawing
  --------------------------------------------------------------------- */

  const dayLabel = formatInstantDate(day.dayInstant, day.timeZone);

  const segments: RibbonSegment[] = [
    /* Taken material first, so a ghost drawn on top of it wins for the moment
       it is on screen. */
    ...day.blocks.map((block) => ({
      id: block.id,
      state: block.kind === "busy" ? ("booked" as const) : ("blocked" as const),
      startMinute: block.startMinute,
      durationMin: block.durationMin,
      startsAt: block.startsAt,
      endsAt: block.endsAt,
      label: block.kind === "busy" ? "Booked" : "Closed",
      isPast:
        day.nowMinute !== null &&
        block.startMinute + block.durationMin <= day.nowMinute,
    })),

    ...day.offers.map((offer) => {
      const selected = hold?.startsAt === offer.startsAt;

      return {
        id: offer.id,
        state: selected ? ("selected" as const) : ("open" as const),
        startMinute: offer.startMinute,
        durationMin: offer.durationMin,
        startsAt: offer.startsAt,
        endsAt: offer.endsAt,
        holdRemaining: selected ? countdown.fraction : undefined,
        label: selected ? "Held for you" : undefined,
        disabled: pendingStart !== null,
      };
    }),

    /* The ghosts: slots that went while the visitor was looking at them. They
       fade to hatched over 240ms in the place the visitor was looking, then
       clear, leaving the real busy material underneath. */
    ...justTaken.flatMap((startsAt) => {
      /* Positioned on the busy block that took the slot, so the fade happens
         exactly where the visitor was looking. */
      const at = Date.parse(startsAt);

      const block = day.blocks.find(
        (candidate) =>
          candidate.kind === "busy" &&
          at >= Date.parse(candidate.startsAt) &&
          at < Date.parse(candidate.endsAt),
      );

      return block
        ? [
            {
              id: `ghost-${startsAt}`,
              state: "held" as const,
              startMinute: block.startMinute,
              durationMin: block.durationMin,
              startsAt: block.startsAt,
              endsAt: block.endsAt,
              label: "Just went",
              justTaken: true,
            },
          ]
        : [];
    }),
  ];

  const summary = hold ? (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="type-label">Held for you</p>
        <p className="type-time-lg truncate text-ink">
          {formatInstantRange(hold.startsAt, hold.endsAt, day.timeZone)}
        </p>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex flex-col items-end">
          <span
            className={cn(
              "type-time-lg tabular",
              countdown.warning ? "text-pending" : "text-ink",
            )}
            /* The seconds are announced only as they cross a threshold; a live
               region ticking once a second would be unusable. */
            aria-hidden="true"
          >
            {formatCountdown(countdown.secondsRemaining)}
          </span>
          <span className="type-label">
            {countdown.warning ? "Hurry" : "Left"}
          </span>
        </div>

        <PillButton asChild>
          <Link href={detailsHref}>Continue</Link>
        </PillButton>
      </div>

      <p role="status" className="sr-only">
        {countdown.warning
          ? "Less than a minute left on your slot."
          : `Your slot is held for ${formatCountdown(countdown.secondsRemaining)}.`}
      </p>
    </div>
  ) : (
    <p className="type-body text-ink-muted">
      Pick a time and we will hold it for you while you finish booking.
    </p>
  );

  return (
    <BookingShell
      step={step}
      totalSteps={totalSteps}
      header={header}
      choices={choices}
      summary={summary}
    >
      <section className="flex flex-col gap-5">
        <StepHeading
          eyebrow="Time"
          title="Pick a time"
          /* A free consultation says "Free", not "€0.00". A currency-formatted
             zero reads as a price that has not loaded yet. */
          description={`${dayLabel}. ${service.name}, ${formatDuration(
            service.durationMin,
          )}, ${
            service.priceCents > 0
              ? formatCents(service.priceCents, currency)
              : "free"
          }${service.depositLine ? ` — ${service.depositLine}` : ""}.`}
        />

        {notice ? (
          <div
            role="status"
            className="flex flex-col gap-3 rounded-card border border-line bg-surface-sunk px-4 py-3"
          >
            <p className="type-body text-ink">{notice.message}</p>

            {notice.nearest.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {notice.nearest.map((offer) => (
                  <PillButton
                    key={offer.id}
                    size="sm"
                    variant="secondary"
                    onClick={() => choose(offer)}
                  >
                    {formatInstant(offer.startsAt, day.timeZone)}
                  </PillButton>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {day.offers.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-card border border-dashed border-line bg-surface px-5 py-6">
            <CalendarOff aria-hidden="true" className="size-5 text-ink-faint" />
            <p className="type-section text-ink">
              {day.closed
                ? "Closed on this day"
                : "Every time on this day has gone"}
            </p>
            <p className="type-body text-ink-muted">
              Go back a step and pick another day — the calendar only offers
              days with something free.
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4">
              <p className="type-body-sm text-ink-muted">
                {day.offers.length === 1
                  ? "One time left"
                  : `${day.offers.length} times to choose from`}
              </p>

              {/* Two readings of one day. See the note on SlotList. */}
              <div
                role="group"
                aria-label="How to show the day"
                className="flex items-center gap-1 rounded-pill border border-line bg-surface p-1"
              >
                <ViewToggle
                  active={view === "ribbon"}
                  onClick={() => setView("ribbon")}
                  icon={<Rows3 aria-hidden="true" className="size-4" />}
                  label="To scale"
                />
                <ViewToggle
                  active={view === "list"}
                  onClick={() => setView("list")}
                  icon={<List aria-hidden="true" className="size-4" />}
                  label="List"
                />
              </div>
            </div>

            {view === "ribbon" ? (
              <Ribbon
                window={day.window}
                columns={[{ id: day.date, label: dayLabel, segments }]}
                timeZone={day.timeZone}
                nowMinute={day.nowMinute}
                onSelectSegment={(segment) => {
                  const offer = day.offers.find(
                    (candidate) => candidate.id === segment.id,
                  );

                  if (offer) {
                    choose(offer);
                  }
                }}
                hideColumnHeaders
                ariaLabel={`Times on ${dayLabel}`}
              />
            ) : (
              <SlotList
                day={day}
                selectedStartsAt={hold?.startsAt ?? null}
                pendingStartsAt={pendingStart}
                countdown={countdown}
                onSelect={choose}
              />
            )}
          </>
        )}

        {day.grantedStarts > day.offers.length ? (
          <p className="type-body-sm text-ink-faint">
            Times are offered back to back so each one shows its true length.
          </p>
        ) : null}

        {view === "ribbon" ? (
          <RibbonLegend states={["open", "selected", "held", "booked"]} />
        ) : null}
      </section>
    </BookingShell>
  );
}

function ViewToggle({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "type-body-sm inline-flex h-8 items-center gap-2 rounded-pill px-3",
        active
          ? "bg-surface-sunk text-ink"
          : "text-ink-muted hover:text-ink",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
