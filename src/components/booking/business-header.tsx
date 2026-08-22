import { MapPin } from "lucide-react";

import { TimezoneNote } from "@/components/booking/timezone-note";

/**
 * Who you are booking with, at the top of every step.
 *
 * Four facts and no logo slot: the name, a line about the business, where it
 * is, and what time it keeps. The last one is not decoration — a booking page
 * that does not say which clock it is speaking in is the single most common
 * way this kind of product wastes somebody's morning.
 *
 * The name is the page's `h1` and stays that on every step; each step's
 * question is an `h2` underneath. A screen reader user tabbing in halfway
 * through a flow should hear the shop first, not "Pick a day".
 */
export function BusinessHeader({
  business,
  instant,
}: {
  business: {
    name: string;
    description: string | null;
    address: string | null;
    timezone: string;
  };
  /** Server "now", for reading the timezone offsets in force. */
  instant: string;
}) {
  return (
    <header className="flex flex-col gap-3">
      <h1 className="type-page-title text-ink">{business.name}</h1>

      {business.description ? (
        <p className="type-body text-ink-muted">{business.description}</p>
      ) : null}

      {business.address ? (
        <p className="type-body-sm flex items-start gap-2 text-ink-muted">
          <MapPin aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {/* An address is written on several lines by the person who typed
              it, and reflowing it into one is how a building number ends up
              next to a postcode. */}
          <span className="whitespace-pre-line">{business.address}</span>
        </p>
      ) : null}

      <TimezoneNote timeZone={business.timezone} instant={instant} />
    </header>
  );
}
