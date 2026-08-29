"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { useRouter } from "next/navigation";

import { PillButton } from "@/components/pill-button";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import {
  calendarHref,
  type CalendarStaffOption,
  type CalendarView,
} from "@/lib/admin/calendar";
import { cn } from "@/lib/utils";

/**
 * Where you are, and how to get somewhere else.
 *
 * ═══ EVERY CONTROL IS A LINK, NOT A HANDLER ═══
 *
 * Back, forward, Today and the day/week switch are all `<Link>`s to a URL the
 * SERVER computed. Two reasons, and the second is the important one:
 *
 *   1. They behave like navigation because they are navigation — middle click,
 *      the back button and a bookmarked Thursday all work with no code.
 *   2. THE CLIENT MUST NOT WORK OUT WHAT TOMORROW IS. "The next day" is
 *      calendar arithmetic in the business's timezone, and the day it goes
 *      wrong is a DST boundary, where adding 86 400 000 milliseconds lands on
 *      23:00 the same evening. The server did that sum with Temporal and put
 *      the answer in the href.
 *
 * The jump-to-date field is the one exception, because a date picker has to
 * produce a value the user chose. It still does no arithmetic: `<input
 * type="date">` yields "2026-09-14", which is a local calendar date, and that
 * string is handed straight back to the server.
 */
export function DateNavigator({
  view,
  date,
  heading,
  subheading,
  staffId,
  staff,
  previousHref,
  nextHref,
  todayHref,
  isToday,
}: {
  view: CalendarView;
  /** The local date the URL is on, for the jump-to-date field's value. */
  date: string;
  /** "Thursday, 20 August" or "18 – 24 August". Formatted on the server. */
  heading: string;
  subheading?: string;
  staffId: string | null;
  staff: CalendarStaffOption[];
  previousHref: string;
  nextHref: string;
  todayHref: string;
  isToday: boolean;
}) {
  const router = useRouter();
  const jumpId = useId();
  const staffFilterId = useId();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <PillButton asChild variant="secondary" size="icon-sm">
            <Link
              href={previousHref}
              aria-label={view === "day" ? "Previous day" : "Previous week"}
              scroll={false}
            >
              <ChevronLeft aria-hidden="true" />
            </Link>
          </PillButton>

          <PillButton asChild variant="secondary" size="icon-sm">
            <Link
              href={nextHref}
              aria-label={view === "day" ? "Next day" : "Next week"}
              scroll={false}
            >
              <ChevronRight aria-hidden="true" />
            </Link>
          </PillButton>
        </div>

        <PillButton
          asChild
          variant={isToday ? "primary" : "secondary"}
          size="sm"
          /* `aria-current`, NOT `aria-pressed`. This is a link, and
             aria-pressed is only valid on something that has a pressed state.
             axe calls it a critical violation and is right to: a screen reader
             announcing "pressed" on a navigation link describes a control that
             does not exist. The button stays visible when you are already on
             today rather than disappearing, so the target does not move under
             the cursor as the days go by; `aria-current` is what says so. */
          aria-current={isToday ? "date" : undefined}
        >
          <Link href={todayHref} scroll={false}>
            Today
          </Link>
        </PillButton>

        <div className="flex min-w-0 flex-col">
          <span className="type-page-title truncate text-ink">{heading}</span>
          {subheading ? (
            <span className="type-body-sm text-ink-muted">{subheading}</span>
          ) : null}
        </div>

        <div className="ml-auto flex items-center gap-1 rounded-pill border border-line bg-surface p-1">
          <ViewTab
            href={calendarHref({ view: "day", date, staffId })}
            current={view === "day"}
          >
            Day
          </ViewTab>
          <ViewTab
            href={calendarHref({ view: "week", date, staffId })}
            current={view === "week"}
          >
            Week
          </ViewTab>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor={jumpId} className="type-label">
            Jump to
          </label>
          <Input
            id={jumpId}
            type="date"
            value={date}
            className="w-44"
            onChange={(event) => {
              const next = event.target.value;

              /* An empty field is the picker being cleared, not a request to
                 go to the beginning of time. */
              if (next) {
                router.push(calendarHref({ view, date: next, staffId }), {
                  scroll: false,
                });
              }
            }}
          />
        </div>

        {staff.length > 1 ? (
          <div className="flex flex-col gap-2">
            <label htmlFor={staffFilterId} className="type-label">
              Staff
            </label>
            <SelectNative
              id={staffFilterId}
              value={staffId ?? ""}
              className="w-52"
              onChange={(event) => {
                router.push(
                  calendarHref({
                    view,
                    date,
                    staffId: event.target.value || null,
                  }),
                  { scroll: false },
                );
              }}
            >
              <option value="">Everyone</option>
              {staff.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </SelectNative>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ViewTab({
  href,
  current,
  children,
}: {
  href: string;
  current: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={current ? "page" : undefined}
      className={cn(
        "type-section flex h-8 items-center rounded-pill px-4 transition-colors",
        current
          ? "bg-accent text-accent-contrast"
          : "text-ink-muted hover:bg-surface-sunk hover:text-ink",
      )}
    >
      {children}
    </Link>
  );
}
