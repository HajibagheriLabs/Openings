"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

import { ADMIN_NAV, isNavItemActive } from "./nav-items";

/**
 * The list of destinations, shared by the rail and the drawer.
 *
 * Collapsed, it is icons only — and then each link carries its label as an
 * accessible name and a native tooltip, because an icon on its own is a
 * guessing game for everyone and unusable with a screen reader.
 *
 * The current item is marked by a filled --accent-wash and `aria-current`, not
 * by colour alone.
 */
export function AdminNav({
  collapsed = false,
  onNavigate,
  className,
}: {
  collapsed?: boolean;
  /** Lets the mobile drawer close itself when a link is followed. */
  onNavigate?: () => void;
  className?: string;
}) {
  const pathname = usePathname();

  return (
    <nav aria-label="Admin" className={cn("flex flex-col gap-1", className)}>
      {ADMIN_NAV.map((item) => {
        const active = isNavItemActive(item, pathname);
        const Icon = item.icon;

        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            title={collapsed ? item.label : undefined}
            className={cn(
              "flex h-11 items-center gap-3 rounded-pill transition-colors",
              collapsed ? "w-11 justify-center px-0" : "px-4",
              active
                ? "bg-accent-wash text-accent"
                : "text-ink-muted hover:bg-surface-sunk hover:text-ink",
            )}
          >
            <Icon aria-hidden="true" className="size-4 shrink-0" />
            <span className={cn("type-section", collapsed && "sr-only")}>
              {item.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
