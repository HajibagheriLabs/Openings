import "server-only";

import { db } from "@/db";
import { ANY_STAFF } from "@/lib/booking/url";
import type { HoldSnapshot, PickerSnapshot } from "@/lib/booking/hold";
import { loadDayView, type DayViewResult } from "@/lib/scheduling/day-view";
import { Temporal } from "@/lib/scheduling/temporal";
import {
  DEFAULT_HOLD_MINUTES,
  readOwnHold,
} from "@/lib/scheduling/booking";
import { loadPublicBusiness } from "@/server/queries/booking-page";
import { loadBookableServices } from "@/server/queries/catalog";

import { readHoldCookie, type HoldCookie } from "./hold-cookie";

/**
 * Everything the time picker needs, resolved from a slug and nothing else.
 *
 * NO ACTION TAKES A BUSINESS ID FROM ITS ARGUMENTS — the same rule the owner
 * area follows, for the same reason. A Server Action is a public HTTP
 * endpoint, and these ones are reachable without any session at all, so every
 * id that decides WHICH ROWS GET WRITTEN is derived here from the public slug
 * rather than accepted from the caller. What the caller may name is a service
 * and a staff member, and both are checked against that business before
 * anything is written.
 */

export interface PickerContext {
  businessId: string;
  slug: string;
  timeZone: string;
  currency: string;
  service: {
    id: string;
    name: string;
    durationMin: number;
    priceCents: number;
    depositType: "none" | "flat" | "percent";
    depositValue: number;
  };
  /**
   * The booking policy, carried alongside so the checks at submit and the
   * sentences on the form are read from one row.
   */
  policy: {
    minLeadTimeMin: number;
    maxAdvanceDays: number;
    cancellationWindowHours: number;
    allowReschedule: boolean;
  };
  /** Qualified, active staff for this service, in display order. */
  team: { id: string; name: string; initials: string }[];
  /** A specific person, or `any`. Always one of `team`, or `any`. */
  staffId: string | typeof ANY_STAFF;
}

export interface ResolvePickerInput {
  slug: string;
  serviceId: string;
  /** A staff id, `any`, or null when the business has one qualified person. */
  staffId: string | null;
}

/**
 * Resolve the slug, service and staff member, or null.
 *
 * Null covers every way the request can fail to name something real — unknown
 * business, unknown service, a service that is not bookable, a staff member
 * who does not perform it — because from outside they are all the same fact
 * and telling them apart would turn this into a probe for what exists.
 */
export async function resolvePicker(
  input: ResolvePickerInput,
): Promise<PickerContext | null> {
  const business = await loadPublicBusiness(input.slug);

  if (!business) {
    return null;
  }

  const services = await loadBookableServices(
    business.id,
    business.slotGranularityMin,
  );

  const service = services.find(
    (candidate) => candidate.id === input.serviceId,
  );

  if (!service) {
    return null;
  }

  const team = service.staff
    .filter((member) => member.isActive)
    .map((member) => ({
      id: member.id,
      name: member.name,
      initials: member.initials,
    }));

  /* A named person has to be on the team. Anything else — `any`, an absent
     parameter, a stylist who left this morning — resolves to "whoever is
     free", which is the safe reading: it can only ever offer more times, never
     somebody who cannot do the job. */
  const staffId =
    input.staffId && team.some((member) => member.id === input.staffId)
      ? input.staffId
      : ANY_STAFF;

  return {
    businessId: business.id,
    slug: business.slug,
    timeZone: business.timezone,
    currency: business.currency,
    policy: {
      minLeadTimeMin: business.minLeadTimeMin,
      maxAdvanceDays: business.maxAdvanceDays,
      cancellationWindowHours: business.cancellationWindowHours,
      allowReschedule: business.allowReschedule,
    },
    service: {
      id: service.id,
      name: service.name,
      durationMin: service.durationMin,
      priceCents: service.priceCents,
      depositType: service.depositType,
      depositValue: service.depositValue,
    },
    team,
    staffId,
  };
}

/**
 * The customer's own live hold, if the cookie points at one that still exists.
 *
 * Returns null for a hold that expired, was released, or was never theirs —
 * the cookie is a hint, the row is the fact, and this is where the two are
 * reconciled. Callers that get null should clear the cookie.
 */
export async function readHoldFor(
  slug: string,
): Promise<{ cookie: HoldCookie; hold: HoldSnapshot } | null> {
  const cookie = await readHoldCookie(slug);

  if (!cookie) {
    return null;
  }

  const row = await readOwnHold(db, cookie.appointmentId, cookie.manageToken);

  if (!row || !row.expiresAt) {
    return null;
  }

  /**
   * An expired-but-unswept row is NOT a live hold to the customer.
   *
   * The row can outlive its deadline — the janitor is housekeeping, not a
   * safety mechanism — and the exclusion constraint keeps blocking on it until
   * something deletes it. But the promise made to this customer was eight
   * minutes, and it is over. Reporting it as live would show a countdown of
   * minus four seconds and a slot the next booking transaction will sweep out
   * from under them.
   */
  if (row.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  return {
    cookie,
    hold: toSnapshot(row.id, row.startsAt, row.endsAt, row.expiresAt, null),
  };
}

/**
 * The local calendar date an instant falls on, in the business's zone.
 *
 * Used to decide whether a hold belongs to the day being looked at. A customer
 * who takes 14:00 on Tuesday and then goes back to pick Wednesday is carrying
 * a cookie that points at a Tuesday hold: reporting it would put a countdown
 * on screen for a time that is not on the day in front of them.
 */
export function localDateOf(instant: string, timeZone: string): string {
  return Temporal.Instant.from(instant)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString();
}

/**
 * Build the snapshot the browser redraws itself from.
 *
 * One function, so the initial server render, a hold, a release and every poll
 * all produce the same shape from the same source. The picker never has to
 * merge two differently-shaped answers.
 */
export async function loadPickerSnapshot(
  context: PickerContext,
  date: string,
  hold: { appointmentId: string; startsAt: string } | null,
  holdSnapshot: HoldSnapshot | null,
): Promise<{ snapshot: PickerSnapshot; day: DayViewResult } | null> {
  const now = new Date();

  /**
   * A hold on ANOTHER day is not this day's business.
   *
   * It is left alone rather than released: releasing would be a write during a
   * page render, and the stray hold ends on its own deadline within eight
   * minutes anyway. If the customer takes a time on this day first, `moveHold`
   * gives the stray one back in the same transaction — which is the path they
   * are overwhelmingly likely to take.
   */
  const onThisDay =
    hold !== null && localDateOf(hold.startsAt, context.timeZone) === date;

  const day = await loadDayView({
    db,
    businessId: context.businessId,
    serviceId: context.service.id,
    staffId: context.staffId,
    timeZone: context.timeZone,
    date,
    now,
    excludeAppointmentId: onThisDay ? hold.appointmentId : undefined,
    anchorStartsAt: onThisDay ? hold.startsAt : undefined,
  });

  if (!day) {
    return null;
  }

  return {
    snapshot: {
      day: day.view,
      hold:
        holdSnapshot && onThisDay
          ? { ...holdSnapshot, serverNow: now.toISOString() }
          : null,
    },
    day,
  };
}

/** Row facts to the wire shape. `takenAt` is the server's clock, not the row's. */
export function toSnapshot(
  appointmentId: string,
  startsAt: Date,
  endsAt: Date,
  expiresAt: Date,
  takenAt: Date | null,
): HoldSnapshot {
  return {
    appointmentId,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    /**
     * For a hold read back later, "when it was taken" is derived rather than
     * stored: the deadline minus the hold length is the same instant, and it
     * keeps the depleting bar's full-scale correct for a page that reloaded
     * halfway through.
     */
    takenAt: (takenAt ?? new Date(expiresAt.getTime() - holdLengthMs())).toISOString(),
    serverNow: new Date().toISOString(),
  };
}

/**
 * The hold's length in milliseconds, read from the ONE place it is configured.
 *
 * Never duplicated as a literal, so changing `DEFAULT_HOLD_MINUTES` moves the
 * countdown, the bar's full-scale, the cookie's lifetime and the database
 * deadline together.
 */
function holdLengthMs(): number {
  return DEFAULT_HOLD_MINUTES * 60_000;
}
