import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { PillButton } from "@/components/pill-button";
import { cn } from "@/lib/utils";

/**
 * Something broke.
 *
 * The house rule for error copy: say what happened and what to do. Never blame
 * the person reading it, never apologise, never say "Oops". The default title
 * here is deliberately flat, and callers are expected to replace it with the
 * actual failure — "That time was just booked by someone else" tells a
 * customer far more than "Something went wrong" ever will.
 *
 * --cancelled is chrome, so it appears on the icon and nowhere else; the panel
 * itself stays a neutral surface.
 */
export function ErrorState({
  title = "That did not work",
  description,
  action,
  onRetry,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  /** A specific way forward. Beats a retry button whenever one exists. */
  action?: ReactNode;
  /** Adds a plain "Try again" when the operation is genuinely repeatable. */
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-start gap-4 rounded-card border border-line bg-surface px-6 py-8",
        className,
      )}
    >
      <TriangleAlert aria-hidden="true" className="size-5 text-cancelled" />

      <div className="flex flex-col gap-2">
        <p className="type-section text-ink">{title}</p>
        {description ? (
          <p className="type-body max-w-[60ch] text-ink-muted">{description}</p>
        ) : null}
      </div>

      {action ??
        (onRetry ? (
          <PillButton variant="secondary" onClick={onRetry}>
            Try again
          </PillButton>
        ) : null)}
    </div>
  );
}
