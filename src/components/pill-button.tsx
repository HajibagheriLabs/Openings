import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The button of this product: 999px, always.
 *
 * Soft controls, hard time. Every control in Daybook is a pill and every
 * segment on the ribbon is a 2px rectangle, and that contrast is the point —
 * you can tell at a glance which things are actions and which things are
 * quantities of the day.
 *
 * The accent is spent on `primary` and nowhere else on this component.
 * `secondary` is a hairline outline; `quiet` is bare until hovered. There is
 * no ring class anywhere here, because globals.css draws a 2px accent outline
 * at 2px offset on every :focus-visible element in the application and a
 * second ring would double it.
 */
const pillButtonVariants = cva(
  cn(
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-pill",
    "type-section whitespace-nowrap transition-colors select-none",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4",
  ),
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-contrast hover:bg-accent/90",
        secondary:
          "border border-line-strong bg-surface text-ink hover:bg-surface-sunk",
        quiet: "text-ink-muted hover:bg-surface-sunk hover:text-ink",
        /**
         * A chrome colour, and the only place --cancelled appears on a
         * control. Never on the ribbon.
         */
        destructive:
          "border border-cancelled/40 bg-cancelled/10 text-cancelled hover:bg-cancelled/20",
      },
      size: {
        /** 44px — the touch target, and the default for a reason. */
        md: "h-11 px-5",
        sm: "h-9 px-4 text-[13.5px]",
        lg: "h-12 px-6",
        icon: "size-11",
        "icon-sm": "size-9",
      },
      block: {
        true: "w-full",
        false: "",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
      block: false,
    },
  },
);

export function PillButton({
  className,
  variant,
  size,
  block,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof pillButtonVariants> & {
    /** Render as the child element — a Link that should look like a button. */
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="pill-button"
      className={cn(pillButtonVariants({ variant, size, block }), className)}
      {...props}
    />
  );
}

export { pillButtonVariants };
