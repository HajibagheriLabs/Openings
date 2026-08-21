"use client";

import { ChevronDown, LogOut } from "lucide-react";
import { DropdownMenu } from "radix-ui";

import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

/**
 * Who is signed in, and the way out.
 *
 * A dropdown floats, so it takes --shadow-float and the 14px dialog radius —
 * the same rule as sheets and dialogs, and the same short list of things
 * allowed to leave the page surface.
 *
 * Signing out is a form posting to a Server Action, not a fetch: the action
 * revokes the session row AND clears the proxy's business hint together, and a
 * form keeps that working without JavaScript.
 */
export function UserMenu({
  name,
  email,
  signOutAction,
}: {
  name: string;
  email: string;
  /** The Server Action itself, passed down from the layout. */
  signOutAction: () => Promise<void>;
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className={cn(
          "flex h-9 items-center gap-2 rounded-pill border border-line pr-2 pl-1 text-ink-muted transition-colors",
          "hover:bg-surface-sunk hover:text-ink",
        )}
      >
        <span
          aria-hidden="true"
          className="type-time flex size-7 items-center justify-center rounded-pill bg-surface-sunk text-ink-muted"
        >
          {initials || "?"}
        </span>
        <span className="sr-only">Account menu for {name}</span>
        <ChevronDown aria-hidden="true" className="size-3.5" />
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="z-50 w-64 rounded-dialog border border-line bg-surface p-2 shadow-float"
        >
          <div className="flex flex-col gap-0.5 px-3 py-2">
            <p className="type-section truncate text-ink">{name}</p>
            <p className="type-body-sm truncate text-ink-faint">{email}</p>
          </div>

          <DropdownMenu.Separator className="my-2 h-px bg-line" />

          <div className="flex items-center justify-between gap-2 px-3 py-1">
            <span className="type-body-sm text-ink-muted">Theme</span>
            <ThemeToggle />
          </div>

          <DropdownMenu.Separator className="my-2 h-px bg-line" />

          <form action={signOutAction}>
            <DropdownMenu.Item asChild>
              <button
                type="submit"
                className="flex w-full items-center gap-3 rounded-pill px-3 py-2 text-left text-ink-muted transition-colors hover:bg-surface-sunk hover:text-ink data-highlighted:bg-surface-sunk data-highlighted:text-ink"
              >
                <LogOut aria-hidden="true" className="size-4 shrink-0" />
                <span className="type-section">Sign out</span>
              </button>
            </DropdownMenu.Item>
          </form>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
