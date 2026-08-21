import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The top of a page: an eyebrow, a title, a sentence, and the page's actions.
 *
 * The title is Epilogue at page-title size; the eyebrow is the 11px uppercase
 * label. Actions sit on the same line on a wide screen and wrap underneath on
 * a phone, which is where most of this product is read.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex flex-wrap items-start justify-between gap-x-6 gap-y-4",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-2">
        {eyebrow ? <p className="type-label">{eyebrow}</p> : null}
        <h1 className="type-page-title text-ink">{title}</h1>
        {description ? (
          <p className="type-body max-w-[60ch] text-ink-muted">{description}</p>
        ) : null}
      </div>

      {actions ? (
        <div className="flex flex-wrap items-center gap-3">{actions}</div>
      ) : null}
    </header>
  );
}
