import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Nothing here yet, and what to do about it.
 *
 * Plain verbs, sentence case, no filler — an empty list is not an occasion for
 * an apology or an illustration. Say what is missing and give the one action
 * that fixes it.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-4 rounded-card border border-dashed border-line bg-surface px-6 py-12 text-center",
        className,
      )}
    >
      {Icon ? (
        <Icon aria-hidden="true" className="size-6 text-ink-faint" />
      ) : null}

      <div className="flex flex-col gap-2">
        <p className="type-section text-ink">{title}</p>
        {description ? (
          <p className="type-body max-w-[48ch] text-ink-muted">{description}</p>
        ) : null}
      </div>

      {action}
    </div>
  );
}
