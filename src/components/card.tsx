import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A white panel on the warm-grey canvas, 10px, hairline border, NO SHADOW.
 *
 * Depth in Daybook is two tokens and neither of them belongs here.
 * --shadow-float is for things that genuinely float above the page — dialogs,
 * sheets, dropdowns, the sticky booking summary — and --shadow-inset is for a
 * booked segment carved into the ribbon. Everything else, this included,
 * separates itself with a 1px --line and a change of surface.
 */
export function Card({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "rounded-card border border-line bg-surface",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned control — usually a small PillButton. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-4 border-b border-line px-5 py-4",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="type-section text-ink">{title}</h2>
        {description ? (
          <p className="type-body-sm text-ink-muted">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function CardBody({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div className={cn("p-5", className)} {...props}>
      {children}
    </div>
  );
}
