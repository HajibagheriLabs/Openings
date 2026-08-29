import { ArrowRight, MapPin } from "lucide-react";
import Link from "next/link";

import { BookingShell } from "@/components/booking/booking-shell";
import { DurationChip } from "@/components/duration-chip";
import { formatDuration } from "@/components/time-text";
import { TimezoneNote } from "@/components/booking/timezone-note";
import { bookingUrl } from "@/lib/booking/url";
import { describeDepositSplit, formatCents } from "@/lib/money";
import type { PublicOpeningDay } from "@/server/queries/booking-page";
import { cn } from "@/lib/utils";

/**
 * THE BUSINESS'S PAGE, not the first screen of a form.
 *
 * A booking link is the address a salon puts on a shop sign, in an Instagram
 * bio and at the bottom of an invoice. Somebody arriving at it has usually not
 * decided to book yet — they are checking whether this is the right place,
 * where it is, and whether it is open on Saturday. A page that opens with
 * "Step 1 of 4: choose a service" answers none of that and reads like a queue
 * ticket.
 *
 * So the bare URL is a page about the business: who they are, where, when they
 * are open, and what they do with a price against it. The funnel starts at the
 * moment a service is chosen, and from there nothing changes — every step
 * after this is exactly what it was.
 *
 * ═══ WHY THE HOURS ARE HERE AND NOT A CALENDAR ═══
 *
 * These are the PUBLISHED hours: wall-clock, weekly, the same thing painted on
 * a door. They are not availability — Saturday can read 09:00–17:00 and be
 * fully booked — and the page says so in a line, because a visitor who reads
 * opening hours as availability and then finds no slots feels misled by the
 * product rather than informed by it.
 *
 * ═══ THE MAP IS A LINK, NOT AN EMBED ═══
 *
 * An embedded map is a third-party script, a billing key, a consent banner and
 * a layout shift, on a page whose whole job is to get somebody to a time
 * quickly. A link opens the address in whatever maps application the visitor
 * already uses and already trusts, works on every device, and costs nothing to
 * anybody.
 */

export interface FrontPageService {
  id: string;
  name: string;
  description: string | null;
  durationMin: number;
  priceCents: number;
  depositType: "none" | "flat" | "percent";
  depositValue: number;
}

export function BusinessFrontPage({
  slug,
  business,
  services,
  hours,
  instant,
}: {
  slug: string;
  business: {
    name: string;
    description: string | null;
    address: string | null;
    timezone: string;
    currency: string;
    contactEmail: string;
    contactPhone: string | null;
  };
  services: FrontPageService[];
  hours: PublicOpeningDay[];
  /** Server "now", for naming the offset currently in force. */
  instant: string;
}) {
  const anyHours = hours.some((day) => day.intervals.length > 0);

  return (
    /* No progress line. Nothing has been chosen yet, and a bar reading "step 0"
       above a page about a hairdresser is chrome pretending to be progress. */
    <BookingShell>
      <header className="flex flex-col gap-3">
        <h1 className="type-display text-ink">{business.name}</h1>

        {business.description ? (
          <p className="type-body text-ink-muted">{business.description}</p>
        ) : null}

        <TimezoneNote timeZone={business.timezone} instant={instant} />
      </header>

      {business.address ? (
        <section
          aria-labelledby="where-heading"
          className="flex flex-col gap-2"
        >
          <h2 id="where-heading" className="type-label">
            Where
          </h2>

          <p className="type-body flex items-start gap-2 text-ink-muted">
            <MapPin
              aria-hidden="true"
              className="mt-1 size-4 shrink-0 text-ink-faint"
            />
            {/* Written on several lines by the person who typed it, and
                reflowing it into one is how a building number ends up next to
                a postcode. */}
            <span className="whitespace-pre-line">{business.address}</span>
          </p>

          <a
            href={mapsHref(business.address)}
            target="_blank"
            rel="noreferrer"
            className="type-body-sm self-start text-accent underline underline-offset-4"
          >
            Open in Maps
          </a>
        </section>
      ) : null}

      {anyHours ? (
        <section
          aria-labelledby="hours-heading"
          className="flex flex-col gap-3"
        >
          <h2 id="hours-heading" className="type-label">
            Opening hours
          </h2>

          <dl className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
            {hours.map((day) => (
              <div
                key={day.weekday}
                className="flex items-baseline justify-between gap-4 px-4 py-2.5"
              >
                <dt className="type-body-sm text-ink-muted">{day.label}</dt>
                <dd
                  className={cn(
                    "type-time text-right",
                    day.intervals.length > 0 ? "text-ink" : "text-ink-faint",
                  )}
                >
                  {day.intervals.length > 0 ? (
                    day.intervals.map((interval) => (
                      <span key={interval} className="block">
                        {interval}
                      </span>
                    ))
                  ) : (
                    <span className="type-body-sm">Closed</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>

          <p className="type-body-sm text-ink-faint">
            These are the hours the door is open. Whether a particular time is
            free is the next screen.
          </p>
        </section>
      ) : null}

      <section aria-labelledby="services-heading" className="flex flex-col gap-3">
        <h2 id="services-heading" className="type-section text-ink">
          What would you like?
        </h2>

        <ul className="flex flex-col gap-3">
          {services.map((service) => {
            const deposit = describeDepositSplit(service, business.currency);

            return (
              <li key={service.id}>
                <Link
                  href={bookingUrl(slug, { service: service.id })}
                  className="flex items-start gap-4 rounded-card border border-line bg-surface px-4 py-4 transition-colors hover:bg-surface-sunk"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="type-section text-ink">{service.name}</span>

                    {service.description ? (
                      <span className="type-body-sm text-ink-muted">
                        {service.description}
                      </span>
                    ) : null}

                    <span className="flex flex-wrap items-center gap-2 pt-0.5">
                      <DurationChip minutes={service.durationMin} />
                      <span className="type-time text-ink">
                        {formatCents(service.priceCents, business.currency)}
                      </span>
                    </span>

                    {deposit ? (
                      <span className="type-body-sm text-ink-faint">
                        {deposit}
                      </span>
                    ) : null}
                  </span>

                  <ArrowRight
                    aria-hidden="true"
                    className="mt-1 size-4 shrink-0 text-ink-faint"
                  />
                  <span className="sr-only">
                    Book {service.name}, {formatDuration(service.durationMin)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="contact-heading" className="flex flex-col gap-2">
        <h2 id="contact-heading" className="type-label">
          Get in touch
        </h2>
        <p className="type-body-sm text-ink-muted">
          <a
            href={`mailto:${business.contactEmail}`}
            className="text-accent underline underline-offset-4"
          >
            {business.contactEmail}
          </a>
          {business.contactPhone ? (
            <>
              {" · "}
              <a
                href={`tel:${business.contactPhone.replace(/\s/g, "")}`}
                className="text-accent underline underline-offset-4"
              >
                {business.contactPhone}
              </a>
            </>
          ) : null}
        </p>
      </section>
    </BookingShell>
  );
}

/**
 * The address, handed to whatever maps application the visitor uses.
 *
 * `?api=1&query=` is Google's documented, key-free universal URL: on a phone it
 * opens the installed maps app, on a desktop it opens the web map, and it needs
 * no script on this page and no billing account behind it. The newlines an
 * owner typed become spaces, because a query string is one line whatever the
 * sign says.
 */
function mapsHref(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    address.split("\n").join(", "),
  )}`;
}
