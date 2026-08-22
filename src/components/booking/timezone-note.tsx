"use client";

import { Globe } from "lucide-react";
import { useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";

/**
 * "Times shown in Europe/Berlin (business time) — that's 3 hours ahead of you."
 *
 * NEVER SILENTLY CONVERT. Every time on this page is the shop's wall clock,
 * because that is the time the customer will be standing in the doorway at.
 * Quietly re-rendering 14:00 as 11:00 for a visitor in London would be
 * friendly right up until they read the confirmation email, the calendar
 * invite and the shop's front door and found three different answers. So the
 * page states the zone permanently and, when it differs from the visitor's,
 * says by how much — once, quietly, and in the same place on every step.
 *
 * WHY THIS IS A CLIENT COMPONENT. The server cannot know the visitor's
 * timezone: it is not in the request. The first render is therefore the
 * business half of the sentence only — which is exactly what the server sends,
 * so hydration matches — and the comparison joins it on the render after
 * hydration, once the browser can be asked.
 */

/**
 * A zone's offset from UTC at one instant, in minutes.
 *
 * Read off `timeZoneName: "shortOffset"` ("GMT+2", "GMT+05:30") rather than
 * computed by subtracting two formatted timestamps. Asking the platform what
 * the offset IS is a lookup; reconstructing it from wall-clock arithmetic is
 * the kind of client-side date maths this project does not do.
 */
function offsetMinutes(instant: Date, timeZone: string): number | null {
  const label = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    timeZoneName: "shortOffset",
  })
    .formatToParts(instant)
    .find((part) => part.type === "timeZoneName")?.value;

  if (!label) {
    return null;
  }

  // UTC itself has no sign or digits: "GMT".
  if (label === "GMT" || label === "UTC") {
    return 0;
  }

  const match = /^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(label);

  if (!match) {
    return null;
  }

  const sign = match[1] === "-" ? -1 : 1;

  return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

/** 210 minutes to "3 hours 30 minutes". Prose, so no abbreviations. */
function describeGap(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  }

  if (rest > 0) {
    parts.push(`${rest} ${rest === 1 ? "minute" : "minutes"}`);
  }

  return parts.join(" ");
}

/**
 * The visitor's own zone — null while rendering on the server.
 *
 * `useSyncExternalStore` rather than an effect that sets state: the browser's
 * timezone is exactly what this hook is for, an external value React does not
 * own. The server snapshot is null, so the first client render matches the
 * HTML and the comparison appears on the next one, without a cascading render
 * and without a "mounted" flag pretending to be state.
 */
const NEVER_CHANGES = () => () => {};

function visitorTimeZone(): string | null {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
}

function useVisitorTimeZone(): string | null {
  return useSyncExternalStore(NEVER_CHANGES, visitorTimeZone, () => null);
}

/**
 * How the business's clock compares to the visitor's, in words, or null when
 * there is nothing worth saying — same zone, or the browser would not tell us.
 */
function compareZones(
  businessZone: string,
  visitorZone: string | null,
  instant: string,
): string | null {
  if (!visitorZone || visitorZone === businessZone) {
    return null;
  }

  const reference = new Date(instant);
  const business = offsetMinutes(reference, businessZone);
  const visitor = offsetMinutes(reference, visitorZone);

  if (business === null || visitor === null) {
    return null;
  }

  const gap = business - visitor;

  /* Two different identifiers can be the same clock — Paris and Berlin, or a
     zone the browser names by its country. Saying "0 hours ahead" would be
     arithmetic showing through; saying the times match is the fact. */
  if (gap === 0) {
    return "the same clock as where you are";
  }

  return `that's ${describeGap(Math.abs(gap))} ${
    gap > 0 ? "ahead of" : "behind"
  } you`;
}

export function TimezoneNote({
  timeZone,
  instant,
  className,
}: {
  /** The business's IANA identifier. */
  timeZone: string;
  /**
   * A reference instant from the server, for reading the offsets that are in
   * force. Offsets move with DST, so a comparison has to be made AT a moment
   * rather than in the abstract.
   */
  instant: string;
  className?: string;
}) {
  const comparison = compareZones(timeZone, useVisitorTimeZone(), instant);

  return (
    <p
      className={cn(
        "type-body-sm flex items-start gap-2 text-ink-muted",
        className,
      )}
    >
      <Globe aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>
        Times shown in {timeZone.replace(/_/g, " ")} (business time)
        {comparison ? ` — ${comparison}.` : "."}
      </span>
    </p>
  );
}
