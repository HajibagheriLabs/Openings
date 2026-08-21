import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Daybook input.
 *
 * Sunk surface at rest, 999px radius, and 44px tall so it is a real touch
 * target — this is a consumer-facing product read mostly on a phone. The focus
 * ring is deliberately absent from these classes: globals.css draws a 2px
 * accent outline at 2px offset on every `:focus-visible` element in the app,
 * and a second ring here would double it.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "type-body h-11 w-full min-w-0 rounded-pill border border-line bg-surface-sunk px-4 text-ink transition-colors",
        "placeholder:text-ink-faint",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-cancelled",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
