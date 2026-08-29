import { CalendarClock, Clock } from "lucide-react";

import { Card, CardBody, CardHeader } from "@/components/card";
import { StatusBadge } from "@/components/status-badge";

/**
 * How reminders are actually being delivered right now.
 *
 * SAY IT, DO NOT MAKE THEM FIND OUT. Without a delivery service configured
 * every reminder waits for the daily catch-up, which can be up to a day late.
 * That is a legitimate way to run this product — it is what a fresh clone
 * does, and it is never WRONG, only late — but an owner who thinks reminders
 * go out at the minute and discovers otherwise from a customer has been
 * misled by the software.
 *
 * So both modes are stated in plain words, with the consequence attached, and
 * the counts underneath show what is actually queued rather than asking anyone
 * to take it on trust.
 */
export function DeliveryStatus({
  configured,
  scheduled,
  awaitingCatchUp,
}: {
  /** Whether per-booking scheduling is running. */
  configured: boolean;
  /** Pending messages with a delivery booked for their exact minute. */
  scheduled: number;
  /** Pending future messages the daily sweep is carrying. */
  awaitingCatchUp: number;
}) {
  return (
    <Card>
      <CardHeader
        title="Delivery"
        description="How queued messages get out."
        action={
          <StatusBadge tone={configured ? "confirmed" : "pending"}>
            {configured ? "Scheduled per booking" : "Daily catch-up only"}
          </StatusBadge>
        }
      />

      <CardBody className="flex flex-col gap-4">
        <p className="type-body text-ink-muted">
          {configured
            ? "Each reminder has its own delivery booked for the exact minute it is due. A daily sweep runs behind it and catches anything the service missed."
            : "Reminders go out with the daily sweep, so one can be up to a day late. Nothing is lost — every message is a row in the outbox and the sweep delivers it — but the timing is approximate."}
        </p>

        {!configured ? (
          <p className="type-body-sm text-ink-faint">
            Set <code className="text-ink">QSTASH_TOKEN</code> and the two
            QStash signing keys, with{" "}
            <code className="text-ink">NEXT_PUBLIC_APP_URL</code> pointing at an
            address the internet can reach, to schedule each reminder
            individually.
          </p>
        ) : null}

        <dl className="flex flex-wrap gap-x-10 gap-y-4">
          <div className="flex flex-col gap-1">
            <dt className="type-label flex items-center gap-2">
              <CalendarClock aria-hidden="true" className="size-3.5" />
              Scheduled
            </dt>
            <dd className="type-time text-ink">{scheduled}</dd>
          </div>

          <div className="flex flex-col gap-1">
            <dt className="type-label flex items-center gap-2">
              <Clock aria-hidden="true" className="size-3.5" />
              Waiting for the sweep
            </dt>
            <dd className="type-time text-ink">{awaitingCatchUp}</dd>
          </div>
        </dl>
      </CardBody>
    </Card>
  );
}
