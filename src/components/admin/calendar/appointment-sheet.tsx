"use client";

import {
  CheckCheck,
  Mail,
  Phone,
  UserX,
  X,
} from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { PillButton } from "@/components/pill-button";
import { Sheet } from "@/components/sheet";
import { Skeleton } from "@/components/skeleton";
import { AppointmentStatusBadge } from "@/components/status-badge";
import {
  formatInstant,
  formatInstantDate,
  formatInstantRange,
} from "@/components/time-text";
import { Textarea } from "@/components/ui/textarea";
import type { AppointmentDetail } from "@/lib/admin/calendar";
import { formatCents } from "@/lib/money";
import {
  cancelAppointmentAsBusiness,
  readAppointment,
  saveInternalNote,
  settleAppointmentAsBusiness,
} from "@/server/actions/agenda";

/**
 * One appointment, and everything the business can do about it.
 *
 * ═══ LOADED WHEN IT OPENS, NOT WITH THE PAGE ═══
 *
 * The agenda draws forty segments and the owner opens one. Sending forty
 * customers' phone numbers and private notes down with every render would be
 * both slower and a wider exposure than the screen needs — so the ribbon
 * carries initials and a service name, and the contact details arrive when
 * somebody actually asks for them.
 *
 * ═══ MESSAGING IS A `mailto:`, DELIBERATELY ═══
 *
 * "Message the customer" opens the owner's own mail client with the address,
 * the subject and a first line already filled in. That is not a stub for a
 * messaging system: a booking product that grew an inbox would need delivery,
 * threading, retention and a second place for the business to remember to look.
 * The email goes from THEIR address, lands in THEIR sent folder, and the
 * customer can reply to a person. The product's job here is to save them from
 * copying an address and typing the time out.
 */
export function AppointmentSheet({
  appointmentId,
  open,
  onOpenChange,
  timeZone,
  currency,
  businessName,
}: {
  /** Null while nothing is selected. */
  appointmentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  timeZone: string;
  currency: string;
  businessName: string;
}) {
  /**
   * What is loaded, AND WHICH APPOINTMENT IT IS.
   *
   * Kept as one value rather than as `detail` plus a `loading` flag, so that
   * "we are showing the wrong appointment" is not a state this component can
   * be in even for one frame. Opening a second appointment does not have to
   * clear anything: `loaded.id` stops matching, `detail` derives to null, and
   * the skeleton is on screen until the right answer arrives.
   */
  const [loaded, setLoaded] = useState<{
    id: string;
    detail: AppointmentDetail | null;
  } | null>(null);
  const [note, setNote] = useState("");
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [pending, startTransition] = useTransition();

  const detail = loaded?.id === appointmentId ? loaded.detail : null;
  const loading = appointmentId !== null && loaded?.id !== appointmentId;

  useEffect(() => {
    if (!open || !appointmentId) {
      return;
    }

    let cancelled = false;

    void readAppointment(appointmentId).then((found) => {
      /* The owner can close the sheet, or open another appointment, while this
         is in flight. Landing the answer anyway would show them somebody
         else's booking. */
      if (cancelled) {
        return;
      }

      setLoaded({ id: appointmentId, detail: found });
      setNote(found?.internalNote ?? "");
    });

    return () => {
      cancelled = true;
    };
  }, [appointmentId, open]);

  function run(
    action: () => Promise<{ ok: boolean; message: string }>,
    after?: () => void,
  ): void {
    startTransition(async () => {
      const result = await action();

      if (result.ok) {
        toast.success(result.message);
        after?.();

        /* Re-read rather than patch: the action may have changed more than the
           one field pressed — a cancellation also records who did it and how
           much went back. */
        if (appointmentId) {
          setLoaded({
            id: appointmentId,
            detail: await readAppointment(appointmentId),
          });
        }
      } else {
        toast.error(result.message);
      }
    });
  }

  const live = detail?.status === "confirmed";

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side="right"
      title="Appointment"
      description={
        detail
          ? `${detail.serviceName} with ${detail.staffName}`
          : "Loading the details"
      }
      footer={
        detail ? (
          <div className="flex flex-wrap gap-2">
            <PillButton
              size="sm"
              variant="secondary"
              disabled={!live || pending}
              onClick={() =>
                run(() =>
                  settleAppointmentAsBusiness({
                    appointmentId: detail.id,
                    outcome: "completed",
                  }),
                )
              }
            >
              <CheckCheck aria-hidden="true" />
              Done
            </PillButton>

            <PillButton
              size="sm"
              variant="secondary"
              disabled={!live || pending}
              onClick={() =>
                run(() =>
                  settleAppointmentAsBusiness({
                    appointmentId: detail.id,
                    outcome: "no_show",
                  }),
                )
              }
            >
              <UserX aria-hidden="true" />
              No-show
            </PillButton>

            <PillButton
              size="sm"
              variant="destructive"
              disabled={!live || pending}
              onClick={() => setConfirmingCancel(true)}
            >
              <X aria-hidden="true" />
              Cancel
            </PillButton>
          </div>
        ) : null
      }
    >
      {loading ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : !detail ? (
        <p className="type-body text-ink-muted">
          That appointment is not on your calendar any more. Close this and the
          agenda will be up to date.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <span className="type-time-lg text-ink">
              {formatInstantRange(detail.startsAt, detail.endsAt, timeZone)}
            </span>
            <span className="type-body text-ink-muted">
              {formatInstantDate(detail.startsAt, timeZone)}
            </span>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <AppointmentStatusBadge status={detail.status} />
              {detail.createdByOwner ? (
                <span className="type-body-sm text-ink-faint">
                  Added by hand
                </span>
              ) : null}
            </div>
          </div>

          {detail.cancellationReason ? (
            <Row label="Why it was cancelled">
              {detail.cancellationReason}
              {detail.cancelledBy ? ` (${detail.cancelledBy})` : null}
            </Row>
          ) : null}

          <section className="flex flex-col gap-3">
            <h3 className="type-label">Customer</h3>

            {detail.customer ? (
              <div className="flex flex-col gap-2">
                <p className="type-section text-ink">{detail.customer.name}</p>

                <a
                  href={mailtoFor(detail, businessName, timeZone)}
                  className="type-body-sm flex items-center gap-2 text-accent underline-offset-4 hover:underline"
                >
                  <Mail aria-hidden="true" className="size-4" />
                  {detail.customer.email}
                </a>

                {detail.customer.phone ? (
                  <a
                    href={`tel:${detail.customer.phone.replace(/\s/g, "")}`}
                    className="type-body-sm flex items-center gap-2 text-accent underline-offset-4 hover:underline"
                  >
                    <Phone aria-hidden="true" className="size-4" />
                    {detail.customer.phone}
                  </a>
                ) : null}
              </div>
            ) : (
              <p className="type-body-sm text-ink-muted">
                Nobody yet — this slot is only being held.
              </p>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="type-label">Money</h3>
            <dl className="flex flex-col gap-2">
              <MoneyRow
                label="Price"
                value={formatCents(detail.priceCents, currency)}
              />
              <MoneyRow
                label="Deposit"
                value={
                  detail.depositCents === 0
                    ? /* A manual booking takes nothing online, and saying "0.00"
                         would read as a deposit that failed rather than one that
                         was never asked for. */
                      "None taken"
                    : `${formatCents(detail.depositCents, currency)}${
                        detail.depositPaid ? " · paid" : " · not paid"
                      }`
                }
              />
              {detail.refundedCents ? (
                <MoneyRow
                  label="Refunded"
                  value={formatCents(detail.refundedCents, currency)}
                />
              ) : null}
              <MoneyRow
                label="Due on the day"
                value={formatCents(
                  Math.max(
                    detail.priceCents -
                      (detail.depositPaid ? detail.depositCents : 0),
                    0,
                  ),
                  currency,
                )}
              />
            </dl>
          </section>

          {detail.customerNote ? (
            <Row label="What they wrote">{detail.customerNote}</Row>
          ) : null}

          <section className="flex flex-col gap-2">
            <label htmlFor="internal-note" className="type-label">
              Your note
            </label>
            <Textarea
              id="internal-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Only you can see this."
              rows={3}
            />
            <div className="flex justify-end">
              <PillButton
                size="sm"
                variant="secondary"
                disabled={pending || note === (detail.internalNote ?? "")}
                onClick={() =>
                  run(() =>
                    saveInternalNote({ appointmentId: detail.id, note }),
                  )
                }
              >
                Save note
              </PillButton>
            </div>
          </section>
        </div>
      )}

      {detail ? (
        <ConfirmDialog
          open={confirmingCancel}
          onOpenChange={setConfirmingCancel}
          title="Cancel this appointment?"
          description={
            detail.depositPaid && detail.depositCents > 0
              ? `${detail.customer?.name ?? "The customer"} will be emailed, and the ${formatCents(
                  detail.depositCents,
                  currency,
                )} deposit goes back automatically — you are the one cancelling, so the policy about keeping deposits does not apply.`
              : `${detail.customer?.name ?? "The customer"} will be emailed and the slot goes back on your calendar straight away.`
          }
          confirmLabel="Cancel it"
          cancelLabel="Keep it"
          destructive
          onConfirm={() =>
            run(
              () =>
                cancelAppointmentAsBusiness({ appointmentId: detail.id }),
              () => setConfirmingCancel(false),
            )
          }
        />
      ) : null}
    </Sheet>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="type-label">{label}</h3>
      <p className="type-body text-ink-muted">{children}</p>
    </section>
  );
}

function MoneyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="type-body-sm text-ink-muted">{label}</dt>
      <dd className="type-time text-ink">{value}</dd>
    </div>
  );
}

/**
 * A pre-filled email to the customer.
 *
 * The time in the body is formatted in the BUSINESS's timezone, because that is
 * the time the business is talking about and the customer's confirmation said
 * the same thing. Everything after the first line is left blank on purpose —
 * the owner has something specific to say, and a paragraph of product-written
 * pleasantry above it would only be in the way.
 */
function mailtoFor(
  detail: AppointmentDetail,
  businessName: string,
  timeZone: string,
): string {
  const when = `${formatInstantDate(detail.startsAt, timeZone)} at ${formatInstant(
    detail.startsAt,
    timeZone,
  )}`;

  const subject = `Your appointment on ${formatInstantDate(
    detail.startsAt,
    timeZone,
  )}`;

  const body = [
    `Hello ${detail.customer?.name ?? ""},`.trim(),
    "",
    `About your ${detail.serviceName} on ${when}:`,
    "",
    "",
    businessName,
  ].join("\n");

  return `mailto:${encodeURIComponent(
    detail.customer?.email ?? "",
  )}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
