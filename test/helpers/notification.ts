import type { NotificationSubject } from "@/lib/notifications/compose";
import type { NotificationKind } from "@/db/schema";

/**
 * One appointment, described exactly as the outbox worker would describe it,
 * without a database.
 *
 * `composeNotification` is pure — it is handed every fact it needs — which is
 * the whole reason the templates and the .ics can be asserted here rather than
 * eyeballed in a mail client. This factory is the other half of that bargain.
 *
 * THE FIXTURE IS DELIBERATELY AWKWARD: a customer four hours behind the
 * business, a deposit that is neither nothing nor the whole price, an address,
 * a note, and a business name with an apostrophe in it. Every assertion below
 * is made against the case that has something to get wrong.
 */

/** 14:00–15:30 in Europe/Berlin (CEST), which is 08:00–09:30 in New York. */
export const STARTS_AT = new Date("2026-09-03T12:00:00.000Z");
export const ENDS_AT = new Date("2026-09-03T13:30:00.000Z");

/** Fixed, so two invites can be compared byte for byte. */
export const STAMP = new Date("2026-08-28T09:00:00.000Z");

export const ICS_UID = "6f1c8a20-3f5e-4d61-9b02-9a7c2f0d1e34@openings";

export const ORIGIN = "https://openings.example";

/** Per-section patches, so a test can change one fact and inherit the rest. */
export interface SubjectOverrides {
  payload?: NotificationSubject["payload"];
  appointment?: Partial<NotificationSubject["appointment"]>;
  business?: Partial<NotificationSubject["business"]>;
  service?: Partial<NotificationSubject["service"]>;
  staff?: Partial<NotificationSubject["staff"]>;
  customer?: Partial<NotificationSubject["customer"]>;
}

export function subjectFor(
  kind: NotificationKind,
  overrides: SubjectOverrides = {},
): NotificationSubject {
  return {
    kind,
    payload: overrides.payload ?? null,
    origin: ORIGIN,
    manageToken: "manage-token-for-tests",
    stamp: STAMP,

    appointment: {
      id: "1c0a8f2e-4b3d-4f7a-8c19-2d3e4f5a6b70",
      status: "confirmed",
      icsUid: ICS_UID,
      icsSequence: 0,
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
      priceCents: 9000,
      depositCents: 2000,
      depositPaid: true,
      customerNote: "Growing out a fringe.",
      cancelledBy: null,
      cancellationReason: null,
      refundedCents: null,
      ...overrides.appointment,
    },

    business: {
      name: "Rosa's Hair Studio",
      slug: "rosas-hair-studio",
      timeZone: "Europe/Berlin",
      currency: "EUR",
      contactEmail: "hello@rosas.example",
      contactPhone: "+49 30 1234 5678",
      address: "Oranienstrasse 12, 10999 Berlin",
      cancellationWindowHours: 24,
      allowReschedule: true,
      refundDepositOnCancel: true,
      ...overrides.business,
    },

    service: {
      id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      name: "Cut and colour",
      durationMin: 90,
      ...overrides.service,
    },

    staff: { name: "Rosa Meier", ...overrides.staff },

    customer: {
      name: "Sam Meyer",
      email: "sam@example.com",
      phone: "+1 212 555 0147",
      timeZone: "America/New_York",
      ...overrides.customer,
    },
  };
}
