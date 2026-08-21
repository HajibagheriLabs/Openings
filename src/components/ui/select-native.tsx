import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A plain `<select>`, styled to match the Daybook input.
 *
 * Native on purpose. The longest list in this product is the IANA timezone
 * list — several hundred entries — and a native select gets type-ahead, the
 * platform's own scrolling, and the phone's wheel picker for free. A custom
 * listbox would have to rebuild all three and would be worse on the device
 * most of these forms are filled in on.
 */
function SelectNative({
  className,
  children,
  ...props
}: React.ComponentProps<"select">) {
  return (
    <div className="relative">
      <select
        data-slot="select-native"
        className={cn(
          "type-body h-11 w-full appearance-none rounded-pill border border-line bg-surface-sunk py-0 pr-10 pl-4 text-ink transition-colors",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "aria-invalid:border-cancelled",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-4 size-4 -translate-y-1/2 text-ink-faint"
      />
    </div>
  );
}

export { SelectNative };
