"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { cn } from "@/lib/utils";

/**
 * Light and dark, with no flash on load.
 *
 * The page never flashes: next-themes injects a tiny blocking script that
 * stamps the class on <html> before first paint, and globals.css defines both
 * token sets, so the whole palette flips at once rather than component by
 * component.
 *
 * THE BUTTON is the part that usually gets this wrong. Which icon to draw
 * depends on the resolved theme, which the server cannot know — render a guess
 * and you get a hydration mismatch and a visible flicker of the wrong icon,
 * and the usual `mounted` flag fixes that by rendering nothing at all for a
 * frame.
 *
 * Neither is necessary. Both icons are always in the DOM and CSS picks one
 * with the same `dark` variant that drives every other colour on the page, so
 * the correct icon is painted by the same blocking script that sets the theme.
 * The resolved theme is then read only inside the click handler, where there
 * is no server to disagree with.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <button
      type="button"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      // Static, so it does not depend on state the server cannot resolve.
      aria-label="Switch between the light and dark theme"
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-pill text-ink-muted transition-colors hover:bg-surface-sunk hover:text-ink",
        className,
      )}
    >
      <Moon aria-hidden="true" className="size-4 dark:hidden" />
      <Sun aria-hidden="true" className="hidden size-4 dark:block" />
    </button>
  );
}
