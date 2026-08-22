"use client";

import { useRef } from "react";

import { PillButton } from "@/components/pill-button";
import {
  Ribbon,
  type RibbonColumn,
  type RibbonHandle,
  type RibbonWindow,
} from "@/components/ribbon";

/**
 * The agenda's ribbon, plus the one control it needs.
 *
 * The Ribbon itself is pure and presentational, which means somebody has to
 * hold the ref and decide when to scroll. That is this component's whole job:
 * it opens the day already looking at now (the design says the agenda scrolls
 * to now on load), and it keeps a button to get back there after the owner has
 * scrolled off to look at four o'clock.
 *
 * Read-only for now — no `onSelectSegment`, so every segment renders inert.
 * Manual booking hangs off exactly that prop when it lands.
 */
export function AgendaRibbon({
  window,
  columns,
  timeZone,
  nowMinute,
}: {
  window: RibbonWindow;
  columns: RibbonColumn[];
  timeZone: string;
  /** Null on a day that is not today — there is no now line to draw on it. */
  nowMinute: number | null;
}) {
  const ribbon = useRef<RibbonHandle>(null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        {typeof nowMinute === "number" ? (
          <PillButton
            variant="secondary"
            size="sm"
            onClick={() => ribbon.current?.scrollNowIntoView()}
          >
            Jump to now
          </PillButton>
        ) : null}
      </div>

      <Ribbon
        ref={ribbon}
        window={window}
        columns={columns}
        timeZone={timeZone}
        nowMinute={nowMinute}
        autoScrollToNow
        ariaLabel="Today's agenda, by staff member"
      />
    </div>
  );
}
