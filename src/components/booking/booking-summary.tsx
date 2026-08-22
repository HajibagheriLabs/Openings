import { CalendarCheck2, Clock, User } from "lucide-react";
import type { ReactNode } from "react";

import {
  formatDuration,
  formatInstantDate,
  formatInstantRange,
  formatTimeZoneAbbreviation,
} from "@/components/time-text";
import type { BookingSummary as BookingSummaryData } from "@/lib/booking/details";
import { formatCents } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * What you are booking, what it costs, and what happens if you cannot come.
 *
 * THE TIME IS A HEADLINE. It is set at `time-lg` in Epilogue with tabular
 * figures and carries its timezone, because this panel is the last thing a
 * person reads before committing and the single most expensive mistake this
 * product can make is showing somebody a time in a zone they did not expect.
 *
 * MONEY IS THREE LINES, NEVER ONE. What leaves the account now, what to bring
 * on the day, and the total. A single "£48.50" is the number that causes the
 * phone call; the split is the number that prevents it.
 *
 * THE POLICY IS ON THE PAGE. Not behind a link, not in a modal, not summarised
 * as "our terms apply" — the actual sentences, next to the box that says you
 * have read them.
 */
export function BookingSummaryPanel({
  summary,
  /** The live hold countdown, rendered by the client that owns the timer. */
  countdown,
  /** Shown once the booking is done, in place of the deposit call-to-action. */
  tone = "pending",
  /**
   * Whether this panel carries the cancellation policy.
   *
   * On the details step it does NOT: the consent box a few inches below prints
   * the same sentences, and the tick has to sit beside the words it refers to.
   * Saying it twice in one 560px column trains people to skip both.
   */
  showPolicy = true,
  className,
}: {
  summary: BookingSummaryData;
  countdown?: ReactNode;
  tone?: "pending" | "confirmed";
  showPolicy?: boolean;
  className?: string;
}) {
  const zone = formatTimeZoneAbbreviation(summary.startsAt, summary.timeZone);

  return (
    <section
      aria-label="Your booking"
      className={cn(
        "flex flex-col gap-4 rounded-card border border-line bg-surface p-5",
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <p className="type-label">
          {tone === "confirmed" ? "Booked" : "You are booking"}
        </p>

        <p className="type-section text-ink">{summary.serviceName}</p>
      </div>

      <div className="flex flex-col gap-1">
        <p className="type-time-lg text-ink">
          {formatInstantRange(
            summary.startsAt,
            summary.endsAt,
            summary.timeZone,
          )}
        </p>

        <p className="type-body text-ink-muted">
          {formatInstantDate(summary.startsAt, summary.timeZone)} ·{" "}
          <span className="type-time">{zone}</span>{" "}
          <span className="text-ink-faint">
            ({summary.timeZone.replace(/_/g, " ")})
          </span>
        </p>
      </div>

      <dl className="flex flex-col gap-2 border-t border-line pt-4">
        <Row
          icon={<User aria-hidden="true" className="size-3.5" />}
          label="With"
          value={summary.staffName}
        />
        <Row
          icon={<Clock aria-hidden="true" className="size-3.5" />}
          label="Takes"
          value={formatDuration(summary.durationMin)}
        />
      </dl>

      <dl className="flex flex-col gap-2 border-t border-line pt-4">
        {summary.depositCents > 0 ? (
          <>
            <Money
              label={tone === "confirmed" ? "Deposit paid" : "Due now"}
              value={formatCents(summary.depositCents, summary.currency)}
              emphasis
            />
            <Money
              label="On the day"
              value={formatCents(summary.balanceCents, summary.currency)}
            />
          </>
        ) : tone === "pending" ? (
          /* No deposit is a FACT worth stating, not a line to leave out — a
             blank where a price would be reads as an oversight. Once it is
             booked the question has been answered and the line goes. */
          <Money
            label="Due now"
            value="Nothing"
            hint="No deposit for this one."
            emphasis
          />
        ) : null}

        <Money
          label="Total"
          value={
            summary.priceCents > 0
              ? formatCents(summary.priceCents, summary.currency)
              : "Free"
          }
        />
      </dl>

      {countdown ? (
        <div className="border-t border-line pt-4">{countdown}</div>
      ) : null}

      {showPolicy ? (
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <p className="type-label">
          <CalendarCheck2
            aria-hidden="true"
            className="mr-1.5 inline size-3.5 align-[-2px]"
          />
          Changing or cancelling
        </p>

        {summary.policyLines.map((line) => (
          <p key={line} className="type-body-sm text-ink-muted">
            {line}
          </p>
        ))}
      </div>
      ) : null}
    </section>
  );
}

function Row({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="type-body-sm flex items-center gap-2 text-ink-muted">
        <span className="text-ink-faint">{icon}</span>
        {label}
      </dt>
      <dd className="type-body-sm text-ink">{value}</dd>
    </div>
  );
}

function Money({
  label,
  value,
  hint,
  emphasis = false,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="type-body-sm text-ink-muted">
        {label}
        {hint ? (
          <span className="block type-body-sm text-ink-faint">{hint}</span>
        ) : null}
      </dt>
      {/* Epilogue and tabular: a column of prices should line up on the decimal
          rather than shimmer as the digits change. */}
      <dd className={cn("type-time", emphasis ? "text-ink" : "text-ink-muted")}>
        {value}
      </dd>
    </div>
  );
}
