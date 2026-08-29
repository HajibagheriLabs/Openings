"use client";

import { CalendarClock, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { ReschedulePicker } from "@/components/manage/reschedule-picker";
import { PillButton } from "@/components/pill-button";
import { formatInstantDate, formatInstantRange } from "@/components/time-text";
import type { CancelResult } from "@/lib/booking/manage-actions";
import { describeCancellationOutcome } from "@/lib/booking/manage-policy";
import type { DayView } from "@/lib/scheduling/day-view";
import { formatCents } from "@/lib/money";
import { cancelBooking } from "@/server/actions/manage";

/**
 * The two things a customer can do, and the honesty around them.
 *
 * ═══ THE MONEY SENTENCE IS COMPUTED FROM THE SAME FACTS THE SERVER USES ═══
 *
 * `describeCancellationOutcome` is the one implementation, shared by this
 * dialog and by nothing else that could contradict it. The screen cannot
 * promise a refund the action will not make, because both read
 * `refund_deposit_on_cancel` and the same deposit off the same row.
 *
 * It is shown INSIDE the confirm dialog, above the button, in the sentence the
 * customer reads last before deciding. Not on the page behind it, where it
 * competes with everything else, and never after — a customer who cancels and
 * then discovers their deposit is gone has been ambushed by software.
 */
export function ManageActions({
  token,
  timeZone,
  currency,
  startsAt,
  endsAt,
  depositCents,
  depositPaid,
  refundDepositOnCancel,
  canReschedule,
  canCancel,
  rescheduleRefusal,
  cancelRefusal,
  initialDay,
}: {
  token: string;
  timeZone: string;
  currency: string;
  startsAt: string;
  endsAt: string;
  depositCents: number;
  depositPaid: boolean;
  refundDepositOnCancel: boolean;
  canReschedule: boolean;
  canCancel: boolean;
  rescheduleRefusal: string | null;
  cancelRefusal: string | null;
  /**
   * The appointment's own day, drawn on the server.
   *
   * Passed in so opening the picker is instant and needs no round trip — the
   * customer is overwhelmingly likely to look at their own day first.
   */
  initialDay: DayView | null;
}) {
  const router = useRouter();
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cancelPending, startCancel] = useTransition();

  const moneyLine = describeCancellationOutcome({
    depositCents,
    depositPaid,
    refundDepositOnCancel,
    depositLabel: formatCents(depositCents, currency),
  });

  function cancel() {
    startCancel(async () => {
      const result: CancelResult = await cancelBooking(token);

      if (!result.ok) {
        toast.error(result.message);
        setConfirming(false);
        return;
      }

      setConfirming(false);
      toast.success(
        result.refundedCents > 0
          ? `Cancelled. ${formatCents(
              result.refundedCents,
              currency,
            )} is on its way back to your card.`
          : "Cancelled. The time is back in their diary.",
      );

      /* The server revalidated this path; refreshing pulls the cancelled state
         rather than patching it here and risking a second idea of the truth. */
      router.refresh();
    });
  }

  if (picking && initialDay) {
    return (
      <ReschedulePicker
        token={token}
        initialDay={initialDay}
        currentStartsAt={startsAt}
        onCancel={() => setPicking(false)}
        onMoved={(movedTo, movedEnd) => {
          setPicking(false);
          toast.success(
            `Moved to ${formatInstantRange(movedTo, movedEnd, timeZone)} on ${formatInstantDate(
              movedTo,
              timeZone,
            )}.`,
          );
          router.refresh();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <PillButton
          type="button"
          variant="secondary"
          onClick={() => setPicking(true)}
          disabled={!canReschedule || !initialDay}
        >
          <CalendarClock aria-hidden="true" className="size-4" />
          Move to another time
        </PillButton>

        <PillButton
          type="button"
          variant="destructive"
          onClick={() => setConfirming(true)}
          disabled={!canCancel}
        >
          <X aria-hidden="true" className="size-4" />
          Cancel this appointment
        </PillButton>
      </div>

      {/* THE REFUSAL IS ON THE PAGE, not hidden behind a disabled button with
          no explanation. A control that cannot be pressed and does not say why
          is worse than no control at all. */}
      {!canReschedule && rescheduleRefusal ? (
        <p className="type-body-sm text-ink-muted">{rescheduleRefusal}</p>
      ) : null}

      {!canCancel && cancelRefusal && cancelRefusal !== rescheduleRefusal ? (
        <p className="type-body-sm text-ink-muted">{cancelRefusal}</p>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Cancel this appointment?"
        description={
          <>
            {formatInstantRange(startsAt, endsAt, timeZone)} on{" "}
            {formatInstantDate(startsAt, timeZone)}. The time goes straight back
            into their diary and cannot be reclaimed.
          </>
        }
        confirmLabel={cancelPending ? "Cancelling" : "Yes, cancel it"}
        cancelLabel="Keep it"
        destructive
        onConfirm={cancel}
      >
        {moneyLine ? (
          <p className="type-body rounded-card bg-surface-sunk px-4 py-3 text-ink">
            {moneyLine}
          </p>
        ) : null}

        {cancelPending ? (
          <p className="type-body-sm text-ink-muted">
            Cancelling — this takes a moment if a refund is going back.
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
