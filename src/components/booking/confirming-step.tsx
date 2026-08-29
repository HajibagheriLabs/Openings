"use client";

import { Clock, Mail } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { BookingShell } from "@/components/booking/booking-shell";
import { StepHeading } from "@/components/booking/step-heading";
import { PillButton } from "@/components/pill-button";
import {
  CONFIRMING_POLL_MS,
  CONFIRMING_TIMEOUT_MS,
} from "@/lib/booking/checkout";
import { bookingUrl } from "@/lib/booking/url";
import { checkPaymentState } from "@/server/actions/checkout";

/**
 * Back from Stripe.
 *
 * ═══ THE REDIRECT IS NOT PROOF OF PAYMENT. ═══
 *
 * This screen exists because of that sentence and nothing else. Stripe sent
 * the customer's BROWSER here; a browser navigation is not a payment, it is a
 * URL that can be typed, shared, replayed from history, or arrived at by
 * pressing back. The appointment is still `held` at this moment. It becomes
 * `confirmed` in exactly one place — the webhook route, after
 * `stripe.webhooks.constructEvent` has verified a signature against
 * STRIPE_WEBHOOK_SECRET — and this component's only job is to wait for that to
 * have happened and say so honestly in the meantime.
 *
 * SO IT POLLS RATHER THAN DECLARES. Every answer it gets is the status of a
 * row, not a reading of the URL it was sent to. If the poll never comes back
 * confirmed, it does NOT conclude the payment failed: it says the confirmation
 * will arrive by email, which is true whichever way the webhook eventually
 * lands, and it stops spinning.
 */
export function ConfirmingStep({
  slug,
  sessionId,
  header,
}: {
  slug: string;
  /** The Checkout Session Stripe returned with, if it did. */
  sessionId: string | null;
  header: ReactNode;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<"waiting" | "slow" | "gone">("waiting");

  /**
   * When the waiting started.
   *
   * A ref, not state: nothing renders from it, and making it state would
   * restart the deadline on every poll. Left null through render and set on
   * the first tick — reading the clock during render is impure, and the only
   * moment that matters is when the polling actually began.
   */
  const startedAt = useRef<number | null>(null);

  const ask = useCallback(async () => {
    const result = await checkPaymentState({ slug, sessionId });

    if (result.state === "confirmed") {
      /**
       * The confirmation lives at its own address, and the session id travels
       * with it: the hold cookie may well have lapsed while the customer was
       * on Stripe's page, and the session id is the other way that page can
       * still resolve the booking.
       *
       * `replace`, not `push` — going back to a page that polls for a payment
       * that has already landed is a dead end nobody meant to visit.
       */
      router.replace(
        bookingUrl(slug, { step: "booked", session: sessionId ?? undefined }),
      );

      return "done" as const;
    }

    if (result.state === "gone") {
      setPhase("gone");
      return "done" as const;
    }

    return "waiting" as const;
  }, [router, sessionId, slug]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    startedAt.current = Date.now();

    const tick = async () => {
      if (cancelled) {
        return;
      }

      const outcome = await ask();

      if (cancelled || outcome === "done") {
        return;
      }

      /**
       * A DEADLINE, NOT A RETRY LIMIT.
       *
       * Ninety seconds is far longer than any webhook this app will ever wait
       * on — a local `stripe listen` forwards in well under a second. Stopping
       * is not giving up on the booking; it is refusing to show somebody a
       * spinner forever for something that will reach them by email regardless.
       */
      if (Date.now() - (startedAt.current ?? Date.now()) >= CONFIRMING_TIMEOUT_MS) {
        setPhase("slow");
        return;
      }

      timer = setTimeout(() => void tick(), CONFIRMING_POLL_MS);
    };

    void tick();

    return () => {
      cancelled = true;

      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [ask]);

  /** One more look, for somebody who would rather press a button than wait. */
  const [rechecking, setRechecking] = useState(false);

  async function recheck() {
    setRechecking(true);
    startedAt.current = Date.now();

    const outcome = await ask();

    setRechecking(false);

    if (outcome === "waiting") {
      setPhase("slow");
    }
  }

  return (
    <BookingShell header={header}>
      <section className="flex flex-col gap-5">
        {phase === "waiting" ? (
          <>
            <StepHeading
              eyebrow="Payment"
              title="Confirming your booking"
              description="Your payment has gone through to Stripe. We are waiting for it to reach us — this usually takes a second or two."
            />

            <div
              role="status"
              className="flex items-center gap-3 rounded-card border border-line bg-surface px-5 py-4"
            >
              {/* A clock face, not a spinner. What this is waiting for is
                  Stripe's webhook, which takes as long as it takes; a rotating
                  ring implies a measurable amount of progress and there is
                  none to report. The only motion in this product is the hold
                  countdown, the 240ms fade on a slot somebody took, and the
                  agenda scrolling to now. */}
              <Clock aria-hidden="true" className="size-4 shrink-0 text-accent" />
              <p className="type-body text-ink-muted">
                Waiting for confirmation. Keep this page open.
              </p>
            </div>

            <p className="type-body-sm text-ink-faint">
              Nothing is charged twice if you refresh, and your confirmation
              email is sent either way.
            </p>
          </>
        ) : (
          <>
            <StepHeading
              eyebrow="Payment"
              title={
                phase === "gone"
                  ? "We are finishing this off by email"
                  : "This is taking longer than usual"
              }
              description={
                phase === "gone"
                  ? "We cannot show your booking on this device — the link that identified it has expired. Your confirmation email has everything in it, including the link to change or cancel."
                  : "Your payment is with Stripe and your booking is being confirmed. The confirmation email will land shortly whether or not this page is open."
              }
            />

            <div
              role="status"
              className="flex flex-col items-start gap-3 rounded-card border border-line bg-surface px-5 py-4"
            >
              <Mail aria-hidden="true" className="size-5 text-ink-faint" />

              <p className="type-body text-ink">
                Check your inbox in a few minutes. If nothing arrives, get in
                touch with the business — they can see the booking at their end.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <PillButton
                variant="secondary"
                onClick={() => void recheck()}
                disabled={rechecking}
              >
                {rechecking ? "Checking" : "Check again"}
              </PillButton>

              <PillButton asChild variant="quiet">
                <Link href={bookingUrl(slug)}>Back to booking</Link>
              </PillButton>
            </div>
          </>
        )}
      </section>
    </BookingShell>
  );
}
