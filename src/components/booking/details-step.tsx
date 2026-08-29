"use client";

import { Clock, CreditCard, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useState, useTransition } from "react";

import { BookingShell } from "@/components/booking/booking-shell";
import { BookingSummaryPanel } from "@/components/booking/booking-summary";
import { StepHeading } from "@/components/booking/step-heading";
import {
  formatCountdown,
  useHoldCountdown,
} from "@/components/booking/use-hold-countdown";
import { Field, FormError } from "@/components/field";
import { PillButton } from "@/components/pill-button";
import { formatInstant, formatInstantDate } from "@/components/time-text";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { StartCheckoutResult } from "@/lib/booking/checkout";
import type { BookingSummary } from "@/lib/booking/details";
import type { HoldSnapshot } from "@/lib/booking/hold";
import type { PolicyRefusal } from "@/lib/booking/policy";
import { formatCents } from "@/lib/money";
import {
  bookingDetailsSchema,
  EMPTY_BOOKING_DETAILS,
  type BookingDetailsField,
  type BookingDetailsInput,
} from "@/lib/validation/booking-details";
import { bookingUrl } from "@/lib/booking/url";
import { cn } from "@/lib/utils";
import { beginCheckout } from "@/server/actions/checkout";
import { submitDetails } from "@/server/actions/details";

/**
 * Step 5 — who you are.
 *
 * FOUR FIELDS AND A TICK BOX, AND EVERY ONE OF THEM EARNS ITS PLACE. A form on
 * a held slot is a form with a clock running: anything that is not needed to
 * confirm the appointment or to reach the customer if something changes is a
 * field that costs a booking.
 *
 * NOTHING HERE DECIDES ANYTHING. The Zod parse below puts a message under the
 * field the moment focus leaves it, which is a courtesy; the same schema is
 * parsed again on the server, along with every policy check, because a Server
 * Action is a public HTTP endpoint. See src/server/actions/details.ts.
 */
export function DetailsStep({
  slug,
  summary,
  hold,
  backHref,
  step,
  totalSteps,
  header,
  choices,
}: {
  slug: string;
  summary: BookingSummary;
  /** The live hold, for the countdown. */
  hold: HoldSnapshot;
  /** Back to the picker, with the service, staff and day intact. */
  backHref: string;
  step: number;
  totalSteps: number;
  header: ReactNode;
  choices: ReactNode;
}) {
  const router = useRouter();
  const [values, setValues] = useState<BookingDetailsInput>(
    EMPTY_BOOKING_DETAILS,
  );
  const [errors, setErrors] = useState<
    Partial<Record<BookingDetailsField, string>>
  >({});
  const [refusal, setRefusal] = useState<PolicyRefusal | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  /**
   * Set once the details are saved and a deposit is owed.
   *
   * Holds the LAST handoff attempt, so the panel below can say what happened:
   * a URL means the browser is already navigating to Stripe, and anything else
   * is a reason plus a way to try again. Null means no deposit step.
   */
  const [payment, setPayment] = useState<StartCheckoutResult | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [pending, startTransition] = useTransition();

  const awaitingPayment = payment !== null;

  const countdown = useHoldCountdown(hold);

  /**
   * The countdown running out is the same fact as a refused submit, so it is
   * DERIVED rather than pushed into state by an effect — the expiry is already
   * a function of the hold and the clock, and storing it again would only
   * create a second copy to keep in sync.
   *
   * WHAT THEY TYPED SURVIVES IT. The form's values are untouched: only the
   * hold is gone. Somebody who takes the slot again comes back to a filled
   * form rather than to a blank one, which is the difference between a small
   * annoyance and starting over.
   */
  const expiredRefusal: PolicyRefusal | null = countdown.expired
    ? {
        code: "hold-expired",
        message:
          "Your hold ran out. Nothing was booked and nothing was charged — pick a time again and everything you have typed will still be here.",
      }
    : null;

  const shownRefusal = refusal ?? expiredRefusal;
  const dead = shownRefusal?.code === "hold-expired";

  function set<K extends keyof BookingDetailsInput>(
    key: K,
    value: BookingDetailsInput[K],
  ) {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  }

  /** Validate one field on the way out of it, never on every keystroke. */
  function validateField(key: BookingDetailsField) {
    const result = bookingDetailsSchema.safeParse(values);

    if (result.success) {
      setErrors((current) => ({ ...current, [key]: undefined }));
      return;
    }

    const issue = result.error.issues.find((candidate) => candidate.path[0] === key);

    setErrors((current) => ({ ...current, [key]: issue?.message }));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    setRefusal(null);

    const parsed = bookingDetailsSchema.safeParse(values);

    if (!parsed.success) {
      const next: Partial<Record<BookingDetailsField, string>> = {};

      for (const issue of parsed.error.issues) {
        const field = issue.path[0];

        if (typeof field === "string" && !(field in next)) {
          next[field as BookingDetailsField] = issue.message;
        }
      }

      setErrors(next);
      return;
    }

    startTransition(async () => {
      const result = await submitDetails({
        ...parsed.data,
        slug,
        /**
         * The one thing the browser knows that the server cannot ask for: the
         * visitor's own timezone. It is not a form field and never becomes
         * one — nobody should be asked to pick their timezone off a list to
         * book a haircut — and it changes nothing about the appointment. It
         * buys one line in the confirmation email: the same instant, said
         * again in the reader's own clock, clearly labelled, for the customer
         * who is booking from another country.
         */
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
      });

      if (result.ok) {
        if (result.outcome === "confirmed") {
          /* Nothing was owed, so the booking is done. The confirmation lives
             at its own address, so a refresh shows the booking rather than a
             picker for a slot that is no longer for sale. */
          router.push(`/book/${slug}?step=booked`);
          return;
        }

        /**
         * A DEPOSIT IS DUE, AND THE SESSION WAS CREATED IN THE SAME CALL.
         *
         * The details are saved against the hold, the slot is still reserved,
         * and the countdown above is still running against the same row.
         * Nothing here is a confirmation — that happens in the verified
         * webhook, after Stripe has taken the money.
         */
        setPayment(result.checkout);
        goToStripe(result.checkout);
        return;
      }

      if (result.reason === "invalid") {
        setErrors(result.fieldErrors);
        return;
      }

      if (result.reason === "policy") {
        setRefusal(result.refusal);
        return;
      }

      setFormError(result.message);
    });
  }

  /**
   * Leave the app.
   *
   * `window.location.assign` rather than the router: Stripe's page is not part
   * of this application and a client-side navigation cannot reach it. A full
   * document navigation is also what makes the back button land on Stripe's
   * own cancel handling rather than halfway through a React transition.
   */
  function goToStripe(result: StartCheckoutResult) {
    if (result.ok && result.url) {
      window.location.assign(result.url);
      return;
    }

    /* Already paid — somebody pressed twice, or came back to an old tab. The
       confirming screen is where that waits for the webhook. */
    if (result.ok) {
      router.push(bookingUrl(slug, { step: "confirming" }));
    }
  }

  /** Try the handoff again. The details are saved; only the session failed. */
  function retryPayment() {
    setRetrying(true);

    startTransition(async () => {
      const result = await beginCheckout({ slug });

      setRetrying(false);
      setPayment(result);

      if (result.ok) {
        goToStripe(result);
        return;
      }

      if (result.reason === "policy") {
        setRefusal(result.refusal);
      }
    });
  }

  const submitLabel =
    summary.depositCents > 0
      ? `Pay ${formatCents(summary.depositCents, summary.currency)} deposit`
      : "Confirm booking";

  /* Present tense, and specific about which of the two things is happening —
     "Taking you to payment" is a promise about the next screen. */
  const pendingLabel =
    summary.depositCents > 0 ? "Taking you to payment" : "Confirming";

  return (
    <BookingShell
      step={step}
      totalSteps={totalSteps}
      header={header}
      choices={choices}
      summary={
        dead ? (
          <PillButton asChild block>
            <Link href={backHref}>Pick another time</Link>
          </PillButton>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-col">
              <span className="type-label">
                {countdown.warning ? "Hurry" : "Held for you"}
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  "type-time-lg tabular",
                  countdown.warning ? "text-pending" : "text-ink",
                )}
              >
                {formatCountdown(countdown.secondsRemaining)}
              </span>
            </div>

            {/* Once the details are saved the form is gone, so the button
                that would submit it goes too rather than sitting there
                offering to do something twice. */}
            {awaitingPayment ? (
              <span className="type-body-sm max-w-[24ch] text-ink-muted">
                Your details are saved. The slot is held until the countdown
                runs out.
              </span>
            ) : (
              <PillButton type="submit" form="booking-details" disabled={pending}>
                {/* The label carries the pending state. A disabled pill at 50%
                    opacity saying "Confirming" is clearer than the same pill
                    with a rotating icon on it, and it does not animate. */}
                {pending ? pendingLabel : submitLabel}
              </PillButton>
            )}

            {/* Announced at its thresholds, never on the tick. See the
                same note on the picker: a live region carrying a running
                clock talks over everything else once a second. */}
            <p role="status" className="sr-only">
              {countdown.warning
                ? "Less than a minute left on your slot. Finish now or it goes back into the day."
                : "Your slot is held while you fill this in."}
            </p>
          </div>
        )
      }
    >
      <section className="flex flex-col gap-5">
        <StepHeading
          eyebrow="Your details"
          title="Who is this for?"
          description="We only need enough to confirm it and reach you if anything changes."
        />

        {/* The policy lives with the consent box below, not here — see the
            note on `showPolicy`. */}
        <BookingSummaryPanel summary={summary} showPolicy={false} />

        {shownRefusal ? (
          <RefusalPanel
            refusal={shownRefusal}
            backHref={backHref}
            timeZone={summary.timeZone}
          />
        ) : null}

        {payment ? (
          <PaymentHandoff
            summary={summary}
            result={payment}
            onRetry={retryPayment}
            retrying={retrying}
          />
        ) : dead ? null : (
          <form
            id="booking-details"
            onSubmit={submit}
            noValidate
            className="flex flex-col gap-5"
          >
            <FormError>{formError}</FormError>

            <Field id="booking-name" label="Name" error={errors.name}>
              {(props) => (
                <Input
                  {...props}
                  value={values.name}
                  onChange={(event) => set("name", event.target.value)}
                  onBlur={() => validateField("name")}
                  placeholder="Sam Taylor"
                  autoComplete="name"
                  autoFocus
                />
              )}
            </Field>

            <Field
              id="booking-email"
              label="Email"
              hint="Your confirmation and the link to change or cancel go here."
              error={errors.email}
            >
              {(props) => (
                <Input
                  {...props}
                  type="email"
                  inputMode="email"
                  value={values.email}
                  onChange={(event) => set("email", event.target.value)}
                  onBlur={() => validateField("email")}
                  placeholder="sam@example.com"
                  autoComplete="email"
                  spellCheck={false}
                />
              )}
            </Field>

            <Field
              id="booking-phone"
              label="Phone"
              optional
              /* OPTIONAL WITH A REASON. "Optional" on its own gets skipped by
                 almost everyone; a concrete thing it is for gets it filled in
                 by most. */
              hint="Worth adding: it is how we reach you if something changes on the day and an email would be too slow."
              error={errors.phone}
            >
              {(props) => (
                <Input
                  {...props}
                  type="tel"
                  inputMode="tel"
                  value={values.phone}
                  onChange={(event) => set("phone", event.target.value)}
                  onBlur={() => validateField("phone")}
                  placeholder="07700 900123"
                  autoComplete="tel"
                />
              )}
            </Field>

            <Field
              id="booking-note"
              label="Anything we should know?"
              optional
              hint="Allergies, access, a preference — whatever helps."
              error={errors.note}
            >
              {(props) => (
                <Textarea
                  {...props}
                  value={values.note}
                  onChange={(event) => set("note", event.target.value)}
                  onBlur={() => validateField("note")}
                  rows={3}
                  maxLength={500}
                />
              )}
            </Field>

            {/* THE POLICY IS RIGHT HERE, IN WORDS. Never behind a link, never
                summarised as "our terms" — the sentences the box refers to are
                the sentences printed above it in the summary panel and
                repeated beside it here. */}
            <div className="flex flex-col gap-2 rounded-card border border-line bg-surface-sunk p-4">
              <label className="flex cursor-pointer items-start gap-3">
                <Checkbox
                  checked={values.policyAccepted === true}
                  onCheckedChange={(checked) =>
                    set(
                      "policyAccepted",
                      (checked === true) as BookingDetailsInput["policyAccepted"],
                    )
                  }
                  aria-invalid={errors.policyAccepted ? true : undefined}
                  aria-describedby={
                    errors.policyAccepted ? "booking-consent-error" : undefined
                  }
                  className="mt-1"
                />

                <span className="flex flex-col gap-1">
                  <span className="type-body text-ink">
                    I have read how changing and cancelling works.
                  </span>

                  {summary.policyLines.map((line) => (
                    <span key={line} className="type-body-sm text-ink-muted">
                      {line}
                    </span>
                  ))}
                </span>
              </label>

              {errors.policyAccepted ? (
                <p
                  id="booking-consent-error"
                  className="type-body-sm text-cancelled"
                >
                  {errors.policyAccepted}
                </p>
              ) : null}
            </div>
          </form>
        )}
      </section>
    </BookingShell>
  );
}

/**
 * A rule said no.
 *
 * Every refusal says what happened and what to do, and the way forward is a
 * real control rather than a suggestion. Nothing here blames the customer:
 * the lead time elapsing while they typed is not their fault, and neither is
 * somebody else booking the slot.
 */
function RefusalPanel({
  refusal,
  backHref,
  timeZone,
}: {
  refusal: PolicyRefusal;
  backHref: string;
  /** The BUSINESS's zone — the only one any time on this page is stated in. */
  timeZone: string;
}) {
  const canGoBack = refusal.code !== "duplicate" && refusal.code !== "rate-limited";

  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-4 rounded-card border border-line bg-surface-sunk px-5 py-4"
    >
      <TriangleAlert aria-hidden="true" className="size-5 text-cancelled" />

      <p className="type-body text-ink">{refusal.message}</p>

      {refusal.existing ? (
        <p className="type-body-sm text-ink-muted">
          {refusal.existing.serviceName} on{" "}
          {formatInstantDate(refusal.existing.startsAt, timeZone)} at{" "}
          <span className="type-time">
            {formatInstant(refusal.existing.startsAt, timeZone)}
          </span>
          .
        </p>
      ) : null}

      {canGoBack ? (
        <PillButton asChild variant="secondary" size="sm">
          <Link href={backHref}>Pick another time</Link>
        </PillButton>
      ) : null}
    </div>
  );
}

/**
 * The deposit is due, and Stripe is the next step.
 *
 * In the ordinary case this is on screen for a fraction of a second: the
 * session was created in the same round trip as the submit and the browser is
 * already navigating to Stripe. It is written for the other case — a Stripe
 * outage, a missing key, a network failure — where the DETAILS ARE SAVED AND
 * THE SLOT IS STILL HELD, and the only thing that failed is one API call. So
 * it says what happened and offers the button again, rather than discarding a
 * booking somebody has already filled in a form for.
 */
function PaymentHandoff({
  summary,
  result,
  onRetry,
  retrying,
}: {
  summary: BookingSummary;
  result: StartCheckoutResult;
  onRetry: () => void;
  retrying: boolean;
}) {
  const amount = formatCents(summary.depositCents, summary.currency);

  /* The happy path and the "already paid" path are both handled by a
     navigation the caller has started. Saying anything more would be a flash
     of text nobody has time to read. */
  if (result.ok) {
    return (
      <div
        role="status"
        className="flex items-center gap-3 rounded-card border border-line bg-surface px-5 py-4"
      >
        <Clock aria-hidden="true" className="size-4 shrink-0 text-accent" />
        <p className="type-body text-ink-muted">
          Taking you to the secure payment page.
        </p>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex flex-col items-start gap-3 rounded-card border border-line bg-surface p-5"
    >
      <CreditCard aria-hidden="true" className="size-5 text-ink-faint" />

      <p className="type-section text-ink">{amount} deposit to pay</p>

      <p className="type-body text-ink-muted">
        {result.reason === "policy"
          ? result.refusal.message
          : result.message}
      </p>

      {result.reason === "error" ? (
        <>
          <p className="type-body-sm text-ink-faint">
            Your details are saved and the slot is still held — nothing has been
            lost.
          </p>

          <PillButton onClick={onRetry} disabled={retrying}>
            {retrying ? "Trying again" : "Try the payment page again"}
          </PillButton>
        </>
      ) : null}
    </div>
  );
}
