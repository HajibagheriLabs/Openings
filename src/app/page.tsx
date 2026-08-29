import { ArrowRight, CreditCard, Globe2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { PillButton } from "@/components/pill-button";
import { RibbonLegend } from "@/components/ribbon";
import { ThemeToggle } from "@/components/theme-toggle";
import { APP_DESCRIPTION, APP_NAME } from "@/lib/brand";
import { loadDemoBusinesses } from "@/server/queries/booking-page";

export const metadata: Metadata = {
  title: `${APP_NAME} — booking for local service businesses`,
  description: APP_DESCRIPTION,
};

/**
 * The front door.
 *
 * ═══ IT ASSUMES THE READER HAS TWO MINUTES AND NO PATIENCE ═══
 *
 * Somebody arriving here is deciding whether to click anything at all. So the
 * page does three things and stops: it says what this is, it hands over the two
 * ways in — the owner's side and a customer's side — and it puts the Stripe
 * test card ON THE SCREEN next to the booking link.
 *
 * That last one is not a detail. The most convincing thing this product can do
 * is take a real deposit through a real Checkout Session and confirm the
 * booking from the verified webhook — and a visitor who has to go and look up
 * a test card number will simply not do it. The number is four words away from
 * the button that needs it.
 *
 * ═══ THE TWO BUSINESSES ARE READ FROM THE DATABASE ═══
 *
 * Not hardcoded. A clone that has not run `npm run db:seed` has no demo, and
 * this page says so plainly instead of linking to a 404 — which is the more
 * common state for anybody who has just cloned it.
 */

/**
 * Stripe's universally-accepted test card. Published deliberately: it is
 * documented, it is not a secret, and it only works against test-mode keys.
 */
const TEST_CARD = {
  number: "4242 4242 4242 4242",
  extra: "Any future expiry date, any 3-digit CVC, any postcode.",
} as const;

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ demo?: string }>;
}) {
  const [demos, { demo }] = await Promise.all([
    loadDemoBusinesses(),
    searchParams,
  ]);

  const seeded = demos.length > 0;

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="mx-auto flex w-full max-w-[720px] justify-end px-5 pt-4">
        <ThemeToggle />
      </div>

      <main className="mx-auto flex w-full max-w-[720px] flex-1 flex-col gap-12 px-5 pt-2 pb-16">
        <header className="flex flex-col gap-4">
          <p className="type-label">{APP_NAME}</p>
          <h1 className="type-display text-ink">
            Booking that gets the time right.
          </h1>
          <p className="type-body max-w-[52ch] text-ink-muted">
            A scheduling engine for clinics, salons and consultants. Slots are
            held in the database while a customer checks out, double-booking is
            refused by Postgres rather than by hopeful application code, and
            every time on every screen is resolved in the business&rsquo;s own
            timezone.
          </p>
        </header>

        {demo === "unavailable" ? (
          /* Sent here by /demo when there is nothing to sign into. An honest
             sentence and the command that fixes it — this is a state a
             reviewer who just cloned the repository will actually hit. */
          <p
            role="status"
            className="type-body-sm rounded-card border border-line bg-surface-sunk px-4 py-3 text-ink-muted"
          >
            The demo workspace has not been set up on this deployment. Running{" "}
            <code className="type-time text-ink">npm run db:seed</code> creates
            it.
          </p>
        ) : null}

        {/* ---- The owner's side ------------------------------------------ */}
        <section aria-labelledby="owner-heading" className="flex flex-col gap-4">
          <h2 id="owner-heading" className="type-page-title text-ink">
            Look around as the business
          </h2>
          <p className="type-body max-w-[52ch] text-ink-muted">
            One click signs you in as the owner of a demo salon and drops you on
            today&rsquo;s agenda: the day drawn to scale, one column per staff
            member, live as bookings land. Nothing you do there is real.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            {/* A real disabled button when there is nothing to enter, rather
                than a link with a `disabled` attribute — an anchor has no such
                attribute, so that would render an enabled link to a redirect. */}
            {seeded ? (
              <PillButton asChild>
                <Link href="/demo">
                  Open the demo workspace
                  <ArrowRight aria-hidden="true" />
                </Link>
              </PillButton>
            ) : (
              <PillButton disabled>Demo not set up</PillButton>
            )}

            <Link
              href="/sign-in"
              className="type-body-sm text-ink-muted underline underline-offset-4 hover:text-ink"
            >
              or sign in to your own
            </Link>
          </div>
        </section>

        {/* ---- The customer's side, and the card ------------------------- */}
        <section
          aria-labelledby="customer-heading"
          className="flex flex-col gap-4"
        >
          <h2 id="customer-heading" className="type-page-title text-ink">
            Or book something, properly
          </h2>
          <p className="type-body max-w-[52ch] text-ink-muted">
            These are ordinary public booking pages — no account, no login. Pick
            a time and it is genuinely held for eight minutes while you check
            out. The deposit goes through Stripe in test mode, and the booking
            is only confirmed once the signed webhook says the money landed.
          </p>

          {seeded ? (
            <ul className="flex flex-col gap-3">
              {demos.map((business) => (
                <li key={business.slug}>
                  <Link
                    href={`/book/${business.slug}`}
                    className="flex items-start gap-4 rounded-card border border-line bg-surface px-4 py-4 transition-colors hover:bg-surface-sunk"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="type-section text-ink">
                        {business.name}
                      </span>
                      {business.description ? (
                        <span className="type-body-sm text-ink-muted">
                          {business.description}
                        </span>
                      ) : null}
                      <span className="type-body-sm flex items-center gap-2 pt-1 text-ink-faint">
                        <Globe2 aria-hidden="true" className="size-3.5" />
                        {business.place ? `${business.place} · ` : null}
                        {business.timezone}
                      </span>
                    </span>

                    <ArrowRight
                      aria-hidden="true"
                      className="mt-1 size-4 shrink-0 text-ink-faint"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="type-body-sm rounded-card border border-dashed border-line px-4 py-3 text-ink-muted">
              No demo businesses yet. Run{" "}
              <code className="type-time text-ink">npm run db:seed</code> to
              create two, in two different timezones.
            </p>
          )}

          {/* THE TEST CARD, next to the thing that needs it. A recruiter will
              not go looking for it, and the payment path is the part worth
              seeing. */}
          <div className="flex flex-col gap-2 rounded-card border border-accent bg-accent-wash px-4 py-4">
            <p className="type-label flex items-center gap-2 text-accent">
              <CreditCard aria-hidden="true" className="size-3.5" />
              Test card
            </p>
            <p className="type-time-lg text-ink">{TEST_CARD.number}</p>
            <p className="type-body-sm text-ink-muted">{TEST_CARD.extra}</p>
            {/* --ink-muted, not --ink-faint. The faint tier clears AA on the
                canvas and on a surface, and this panel is neither: it is an
                accent wash, which sits between them and takes the ratio to
                3.9:1. The tier below is the fix, not a new colour. */}
            <p className="type-body-sm text-ink-muted">
              Stripe test mode. No real money can move through this, and the
              card number is Stripe&rsquo;s own published test value.
            </p>
          </div>
        </section>

        {/* ---- What the drawing means ------------------------------------ */}
        <section aria-labelledby="ribbon-heading" className="flex flex-col gap-4">
          <h2 id="ribbon-heading" className="type-page-title text-ink">
            Time is drawn to scale
          </h2>
          <p className="type-body max-w-[52ch] text-ink-muted">
            A 90-minute appointment takes up three times the space of a
            30-minute one, on the customer&rsquo;s picker and on the
            owner&rsquo;s agenda, because it is the same component at the same
            scale. Booked time is carved out of the day rather than stacked on
            top of it, and no state is signalled by colour alone.
          </p>

          <RibbonLegend className="max-w-[46ch]" />
        </section>
      </main>
    </div>
  );
}
