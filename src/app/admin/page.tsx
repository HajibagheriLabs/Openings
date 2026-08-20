import { asc, eq } from "drizzle-orm";
import type { Metadata } from "next";

import { db } from "@/db";
import { availabilityRules, services, staff } from "@/db/schema";
import { clientEnv } from "@/env";
import {
  getOwnedBusiness,
  requireBusinessAccess,
  requireUser,
} from "@/lib/auth-server";
import { formatCents } from "@/lib/money";
import { WEEKDAYS } from "@/lib/validation/onboarding";

export const metadata: Metadata = {
  title: "Agenda",
};

/**
 * A placeholder agenda.
 *
 * It exists so onboarding has somewhere to land and so the setup can be seen
 * to have worked: the business, the owner's staff row, the hours and the first
 * service, read back out of the database. The Ribbon — the hand-built CSS grid
 * over a time axis, at a fixed pixel-per-minute scale — replaces this whole
 * page next.
 */
export default async function AdminPage() {
  const user = await requireUser("/admin");
  const owned = await getOwnedBusiness(user.id);

  /**
   * Re-resolved through `requireBusinessAccess` rather than trusted from the
   * layout. It is the function every owner route uses, and using it here too
   * keeps that habit unbroken — a page that reads a business without asking
   * whether the caller owns it is exactly the page that eventually takes a
   * slug from the URL.
   */
  const { business } = await requireBusinessAccess(owned!.id);

  const [team, catalogue] = await Promise.all([
    db
      .select()
      .from(staff)
      .where(eq(staff.businessId, business.id))
      .orderBy(asc(staff.displayOrder)),
    db
      .select()
      .from(services)
      .where(eq(services.businessId, business.id))
      .orderBy(asc(services.displayOrder)),
  ]);

  const rules = team.length
    ? await db
        .select()
        .from(availabilityRules)
        .where(eq(availabilityRules.staffId, team[0].id))
        .orderBy(asc(availabilityRules.weekday))
    : [];

  const bookingUrl = `${clientEnv.NEXT_PUBLIC_APP_URL}/book/${business.slug}`;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="type-page-title text-ink">{business.name}</h1>
        <p className="type-body text-ink-muted">
          Set up and ready. Your booking page will live at{" "}
          <span className="text-ink">{bookingUrl}</span>.
        </p>
        <p className="type-body-sm text-ink-faint">
          All times are worked out in {business.timezone.replace(/_/g, " ")}.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="type-label">Opening hours</h2>
        <ul className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4">
          {WEEKDAYS.map(({ weekday, label }) => {
            const rule = rules.find((entry) => entry.weekday === weekday);

            return (
              <li
                key={weekday}
                className="flex items-baseline justify-between gap-4"
              >
                <span className="type-body text-ink">{label}</span>
                {rule ? (
                  <span className="type-time text-ink">
                    {rule.startLocal.slice(0, 5)} – {rule.endLocal.slice(0, 5)}
                  </span>
                ) : (
                  <span className="type-body-sm text-ink-faint">Closed</span>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="type-label">Services</h2>
        <ul className="flex flex-col gap-2">
          {catalogue.map((service) => (
            <li
              key={service.id}
              className="flex flex-wrap items-baseline justify-between gap-3 rounded-card border border-line bg-surface px-4 py-3"
            >
              <span className="type-section text-ink">{service.name}</span>
              <span className="type-time text-ink-muted">
                {service.durationMin} min ·{" "}
                {formatCents(service.priceCents, business.currency)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="type-label">Who takes bookings</h2>
        <ul className="flex flex-col gap-2">
          {team.map((member) => (
            <li
              key={member.id}
              className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3"
            >
              <span className="type-time flex size-9 items-center justify-center rounded-pill bg-surface-sunk text-ink-muted">
                {member.initials}
              </span>
              <span className="type-body text-ink">{member.name}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
