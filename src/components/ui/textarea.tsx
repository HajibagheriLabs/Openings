import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The multi-line input.
 *
 * Card radius, not pill. A 999px radius on a four-line box would eat the first
 * and last words of the text; the Daybook rule is soft controls, and a pill is
 * the shape of a control you press, not one you write a paragraph into.
 * Everything else — the sunk surface, the hairline, the absent focus ring that
 * globals.css draws instead — matches Input exactly.
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "type-body min-h-20 w-full rounded-card border border-line bg-surface-sunk px-4 py-3 text-ink transition-colors",
        "placeholder:text-ink-faint",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-cancelled",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
