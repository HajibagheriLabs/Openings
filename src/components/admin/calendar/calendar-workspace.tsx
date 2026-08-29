"use client";

import {
  CalendarOff,
  List,
  Plus,
  Radio,
  RefreshCw,
  Rows3,
  Users,
  WifiOff,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { PillButton } from "@/components/pill-button";
import {
  Ribbon,
  RibbonLegend,
  type RibbonColumn,
  type RibbonHandle,
  type RibbonRange,
  type RibbonWindow,
} from "@/components/ribbon";
import { formatLocalMinutes } from "@/lib/scheduling/week";
import {
  calendarHref,
  type CalendarParams,
  type CalendarServiceOption,
  type CalendarStaffOption,
} from "@/lib/admin/calendar";
import type { AgendaAppointment, DaySummary } from "@/lib/scheduling/agenda";
import { cn } from "@/lib/utils";

import { AgendaList } from "./agenda-list";
import { AppointmentSheet } from "./appointment-sheet";
import { BlockTimeSheet } from "./block-time-sheet";
import { DateNavigator } from "./date-navigator";
import { TodayPanel } from "./today-panel";
import { ManualBookingSheet } from "./manual-booking-sheet";
import { useAgendaStream, type AgendaStreamStatus } from "./use-agenda-stream";

/**
 * The master schedule.
 *
 * ═══ WHAT THIS COMPONENT OWNS, AND WHAT IT REFUSES TO ═══
 *
 * It owns interaction state and nothing else: which sheet is open, which
 * appointment is selected, where a drag landed. Every date, every instant,
 * every minute of geometry and every href arrived from the server already
 * computed, and this file contains no `Date` arithmetic at all — the one thing
 * it does with time is `formatLocalMinutes(675)` to fill in "11:15" on a form,
 * which is a wall-clock fact and true in every timezone.
 *
 * When something changes it does NOT patch the calendar. `router.refresh()`
 * re-renders the Server Component and the truth comes back from Postgres. That
 * is the whole reason the live stream carries a sentence rather than a
 * booking — see ./use-agenda-stream.ts.
 */
export function CalendarWorkspace({
  params,
  timeZone,
  currency,
  businessName,
  slotGranularityMin,
  nowInstant,
  heading,
  subheading,
  previousHref,
  nextHref,
  todayHref,
  isToday,
  window: ribbonWindow,
  columns,
  nowMinute,
  pxPerMin,
  staff,
  services,
  summary,
  appointments,
  streamFrom,
  streamTo,
  /** Maps a week column back to its local date, so a click can drill into it. */
  columnDates,
}: {
  params: CalendarParams;
  timeZone: string;
  currency: string;
  businessName: string;
  slotGranularityMin: number;
  nowInstant: string;
  heading: string;
  subheading?: string;
  previousHref: string;
  nextHref: string;
  todayHref: string;
  isToday: boolean;
  window: RibbonWindow;
  columns: RibbonColumn[];
  nowMinute: number | null;
  /** The week draws at a smaller scale — seven columns have to fit. */
  pxPerMin?: number;
  staff: CalendarStaffOption[];
  services: CalendarServiceOption[];
  /** Only present in the day view. */
  summary?: DaySummary;
  appointments?: AgendaAppointment[];
  streamFrom: string;
  streamTo: string;
  columnDates?: Record<string, string>;
}) {
  const router = useRouter();
  const ribbon = useRef<RibbonHandle>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [booking, setBooking] = useState<{
    date: string;
    startLocal: string;
    staffId: string | null;
  } | null>(null);
  const [blocking, setBlocking] = useState<{
    date: string;
    startLocal: string;
    endLocal: string;
    staffId: string | null;
  } | null>(null);

  const status = useAgendaStream({ from: streamFrom, to: streamTo });

  const isDay = params.view === "day";

  /**
   * A press on a segment.
   *
   * In the day view a segment id IS an appointment id, so the detail sheet
   * opens. In the week view a segment can be a merged band covering three
   * people's appointments — there is nothing single to open — so it navigates
   * to that day instead, which is where the detail lives. The week view is a
   * map, not a workspace.
   */
  function selectSegment(segmentId: string, columnId: string): void {
    if (isDay) {
      setSelected(segmentId);
      return;
    }

    const date = columnDates?.[columnId];

    if (date) {
      router.push(calendarHref({ view: "day", date, staffId: params.staffId }), {
        scroll: false,
      });
    }
  }

  /**
   * A drag on empty time.
   *
   * The Ribbon hands over minutes since local midnight on that column's day,
   * already snapped to the business's slot grid. Turning them into "14:30" is
   * formatting; turning "14:30" on that date into an instant is the server's
   * job, and it happens in `blockTime`.
   */
  function selectRange(columnId: string, range: RibbonRange): void {
    setBlocking({
      date: isDay ? params.date : (columnDates?.[columnId] ?? params.date),
      startLocal: formatLocalMinutes(range.startMinute),
      endLocal: formatLocalMinutes(range.endMinute),
      /* In the day view a column IS a staff member, so the block lands on the
         lane it was drawn in. In the week view a column is a day for the whole
         business, so it defaults to the whole business — which is what
         dragging across everybody's Thursday means. */
      staffId: isDay ? columnId : params.staffId,
    });
  }

  const defaultStart = nowMinute !== null
    ? formatLocalMinutes(roundUpTo(nowMinute, slotGranularityMin))
    : formatLocalMinutes(ribbonWindow.startMinute);

  /**
   * Which reading of the day is on screen.
   *
   * Interaction state, so it lives here and not in the URL: it is a preference
   * about this screen right now, not a thing to link somebody to. The list is
   * a genuine equivalent, not a fallback — see ./agenda-list.tsx.
   */
  const [view, setView] = useState<"ribbon" | "list">("ribbon");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <DateNavigator
          view={params.view}
          date={params.date}
          heading={heading}
          subheading={subheading}
          staffId={params.staffId}
          staff={staff}
          previousHref={previousHref}
          nextHref={nextHref}
          todayHref={todayHref}
          isToday={isToday}
        />

        <div className="flex flex-wrap items-center gap-2">
          <StreamIndicator status={status} />

          {/* Two readings of one day, the same control the customer's picker
              uses. See ./agenda-list.tsx for why the owner gets one. */}
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

          <PillButton
            size="sm"
            variant="secondary"
            onClick={() =>
              setBlocking({
                date: params.date,
                startLocal: defaultStart,
                endLocal: formatLocalMinutes(
                  Math.min(
                    ribbonWindow.endMinute,
                    parseMinutes(defaultStart) + 60,
                  ),
                ),
                staffId: params.staffId,
              })
            }
          >
            <CalendarOff aria-hidden="true" />
            Block time
          </PillButton>

          <PillButton
            size="sm"
            onClick={() =>
              setBooking({
                date: params.date,
                startLocal: defaultStart,
                staffId: params.staffId ?? staff[0]?.id ?? null,
              })
            }
          >
            <Plus aria-hidden="true" />
            Add a booking
          </PillButton>
        </div>
      </div>

      <div
        className={cn(
          "grid gap-6",
          isDay ? "lg:grid-cols-[minmax(0,1fr)_22rem]" : "grid-cols-1",
        )}
      >
        <div className="flex min-w-0 flex-col gap-3">
          {nowMinute !== null && view === "ribbon" ? (
            <div className="flex justify-end">
              <PillButton
                variant="quiet"
                size="sm"
                onClick={() => ribbon.current?.scrollNowIntoView()}
              >
                Jump to now
              </PillButton>
            </div>
          ) : null}

          {columns.length === 0 ? (
            <EmptyState
              icon={Users}
              title="Nobody to draw yet"
              description="Add a staff member and the calendar gets a column. Until then there is no diary to keep."
              action={
                <PillButton asChild>
                  <Link href="/admin/staff">Add someone</Link>
                </PillButton>
              }
            />
          ) : view === "list" ? (
            <AgendaList
              columns={columns}
              timeZone={timeZone}
              onSelectSegment={(segment, columnId) =>
                selectSegment(segment.id, columnId)
              }
            />
          ) : (
            <Ribbon
              ref={ribbon}
              window={ribbonWindow}
              columns={columns}
              timeZone={timeZone}
              nowMinute={nowMinute}
              pxPerMin={pxPerMin}
              autoScrollToNow
              snapMinutes={slotGranularityMin}
              onSelectSegment={(segment) => {
                const column = columns.find((candidate) =>
                  candidate.segments.some((item) => item.id === segment.id),
                );

                selectSegment(segment.id, column?.id ?? "");
              }}
              onSelectRange={selectRange}
              ariaLabel={
                isDay
                  ? "The day, by staff member"
                  : "The week, one column per day"
              }
            />
          )}

          {view === "ribbon" ? (
            <>
              <p className="type-body-sm text-ink-faint">
                Drag on any empty stretch to block it out. Press an appointment
                to open it.
              </p>

              <RibbonLegend
                states={["open", "held", "booked", "blocked"]}
                className="max-w-[46ch]"
              />
            </>
          ) : (
            <p className="type-body-sm text-ink-faint">
              Press an appointment to open it. Blocking time out is drawn on the
              strip — switch to “To scale” for that.
            </p>
          )}
        </div>

        {isDay && summary && appointments ? (
          <TodayPanel
            onAddBooking={() =>
              setBooking({
                date: params.date,
                startLocal: defaultStart,
                staffId: params.staffId ?? staff[0]?.id ?? null,
              })
            }
            summary={summary}
            appointments={appointments}
            currency={currency}
            timeZone={timeZone}
            nowInstant={nowInstant}
            heading={isToday ? "Today" : heading}
            onOpenAppointment={setSelected}
          />
        ) : null}
      </div>

      <AppointmentSheet
        appointmentId={selected}
        open={selected !== null}
        onOpenChange={(next) => setSelected(next ? selected : null)}
        timeZone={timeZone}
        currency={currency}
        businessName={businessName}
      />

      {booking ? (
        <ManualBookingSheet
          /* A fresh form per opening, seeded from wherever it was opened. Same
             reasoning as the service and staff sheets: a form that remembers
             the last thing typed into it is a form that books the wrong
             person. */
          key={`${booking.date}-${booking.startLocal}-${booking.staffId}`}
          open
          onOpenChange={(next) => !next && setBooking(null)}
          services={services}
          staff={staff}
          currency={currency}
          timeZone={timeZone}
          defaultDate={booking.date}
          defaultStartLocal={booking.startLocal}
          defaultStaffId={booking.staffId}
          onBlockInstead={() => {
            setBlocking({
              date: booking.date,
              startLocal: booking.startLocal,
              endLocal: formatLocalMinutes(
                parseMinutes(booking.startLocal) + 60,
              ),
              staffId: booking.staffId,
            });
            setBooking(null);
          }}
        />
      ) : null}

      {blocking ? (
        <BlockTimeSheet
          key={`${blocking.date}-${blocking.startLocal}-${blocking.endLocal}`}
          open
          onOpenChange={(next) => !next && setBlocking(null)}
          staff={staff}
          defaultDate={blocking.date}
          defaultStartLocal={blocking.startLocal}
          defaultEndLocal={blocking.endLocal}
          defaultStaffId={blocking.staffId}
        />
      ) : null}
    </div>
  );
}

/**
 * Whether the agenda is actually live.
 *
 * SHOWN, RATHER THAN ASSUMED. An owner who is trusting this screen not to
 * double-book them is entitled to know when it has stopped hearing from the
 * server — a silent fallback to polling would be the product quietly lowering
 * its promise. The wording is plain and none of it is alarming: polling still
 * works, it is just slower.
 */
/**
 * One half of the view switch.
 *
 * Deliberately identical to the customer picker's, down to the class list: it
 * is the same control doing the same job on the other side of the product, and
 * two toggles that behave the same should look the same.
 */
function ViewToggle({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "type-body-sm inline-flex h-8 items-center gap-2 rounded-pill px-3",
        active ? "bg-surface-sunk text-ink" : "text-ink-muted hover:text-ink",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function StreamIndicator({ status }: { status: AgendaStreamStatus }) {
  const { Icon, text } = INDICATOR[status];

  return (
    <span
      className="type-body-sm flex items-center gap-2 text-ink-faint"
      role="status"
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {text}
    </span>
  );
}

const INDICATOR: Record<
  AgendaStreamStatus,
  { Icon: typeof Radio; text: string }
> = {
  live: { Icon: Radio, text: "Live" },
  connecting: { Icon: RefreshCw, text: "Reconnecting" },
  polling: { Icon: WifiOff, text: "Checking every 30s" },
};

/** "14:30" back to 870. The inverse of `formatLocalMinutes`, no timezone. */
function parseMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);

  return hours * 60 + minutes;
}

function roundUpTo(minute: number, step: number): number {
  return Math.ceil(minute / step) * step;
}
