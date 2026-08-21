"use client";

import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A panel that slides in from an edge. The admin rail becomes one of these
 * below 1024px.
 *
 * One of the two places --shadow-float is allowed (the other is a dialog, a
 * dropdown, or the sticky booking summary). It genuinely floats above the
 * page, so it gets the float shadow and the 14px dialog radius — and that is
 * the entire justification. Nothing that merely sits on the canvas may borrow
 * either.
 *
 * Radix Dialog underneath, so focus is trapped, Escape closes, the page behind
 * is inert, and the overlay is not something we had to remember to build.
 */

const SIDE_CLASSES = {
  left: "inset-y-0 left-0 h-full w-[min(20rem,86vw)] rounded-r-dialog border-r",
  right:
    "inset-y-0 right-0 h-full w-[min(24rem,86vw)] rounded-l-dialog border-l",
  bottom:
    "inset-x-0 bottom-0 max-h-[85vh] w-full rounded-t-dialog border-t",
} as const;

export type SheetSide = keyof typeof SIDE_CLASSES;

export function Sheet({
  open,
  onOpenChange,
  side = "left",
  title,
  description,
  trigger,
  footer,
  children,
  className,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: SheetSide;
  /** Required by Radix for the accessible name, even when visually hidden. */
  title: string;
  description?: string;
  /** Hide the heading but keep it for assistive technology. */
  trigger?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/25" />

        <Dialog.Content
          className={cn(
            "fixed z-50 flex flex-col border-line bg-surface shadow-float outline-none",
            SIDE_CLASSES[side],
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="flex flex-col gap-1">
              <Dialog.Title className="type-section text-ink">
                {title}
              </Dialog.Title>
              {description ? (
                <Dialog.Description className="type-body-sm text-ink-muted">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>

            <Dialog.Close
              aria-label="Close"
              className="-mr-2 flex size-9 shrink-0 items-center justify-center rounded-pill text-ink-muted transition-colors hover:bg-surface-sunk hover:text-ink"
            >
              <X aria-hidden="true" className="size-4" />
            </Dialog.Close>
          </div>

          <div className="flex-1 overflow-y-auto p-5">{children}</div>

          {footer ? (
            <div className="border-t border-line p-5">{footer}</div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
