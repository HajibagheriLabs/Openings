"use client";

import { AlertDialog } from "radix-ui";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { pillButtonVariants } from "@/components/pill-button";

/**
 * "Are you sure?", for the handful of actions that deserve the question.
 *
 * Radix AlertDialog rather than Dialog: an alert dialog cannot be dismissed by
 * clicking the overlay, and it points the screen reader at the description
 * instead of just the title. Cancelling somebody's appointment should take a
 * deliberate press, not a stray click on the backdrop.
 *
 * Floats, so it earns --shadow-float and the 14px dialog radius.
 *
 * The buttons use `pillButtonVariants` directly rather than <PillButton>,
 * because Radix's Cancel and Action need to own the underlying element to wire
 * up focus and dismissal.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Keep it",
  destructive = false,
  onConfirm,
  trigger,
  children,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Uses the --cancelled chrome colour. Chrome only, never on the ribbon. */
  destructive?: boolean;
  onConfirm: () => void;
  trigger?: ReactNode;
  /** Extra detail between the description and the buttons. */
  children?: ReactNode;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? (
        <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger>
      ) : null}

      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-ink/25" />

        <AlertDialog.Content
          className={cn(
            "fixed top-1/2 left-1/2 z-50 w-[min(28rem,92vw)] -translate-x-1/2 -translate-y-1/2",
            "rounded-dialog border border-line bg-surface p-6 shadow-float outline-none",
          )}
        >
          <AlertDialog.Title className="type-page-title text-ink">
            {title}
          </AlertDialog.Title>

          <AlertDialog.Description className="type-body mt-3 text-ink-muted">
            {description}
          </AlertDialog.Description>

          {children ? <div className="mt-4">{children}</div> : null}

          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <AlertDialog.Cancel
              className={pillButtonVariants({ variant: "secondary" })}
            >
              {cancelLabel}
            </AlertDialog.Cancel>

            <AlertDialog.Action
              onClick={onConfirm}
              className={pillButtonVariants({
                variant: destructive ? "destructive" : "primary",
              })}
            >
              {confirmLabel}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
