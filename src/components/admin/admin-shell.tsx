"use client";

import { Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useState, useSyncExternalStore, type ReactNode } from "react";

import { Sheet } from "@/components/sheet";
import { TimezoneChip } from "@/components/timezone-chip";
import { cn } from "@/lib/utils";
import { APP_NAME } from "@/lib/brand";

import { AdminNav } from "./admin-nav";
import {
  getRailCollapsed,
  getRailCollapsedOnServer,
  setRailCollapsed,
  subscribeToRailCollapse,
} from "./rail-collapse-store";
import { UserMenu } from "./user-menu";

/**
 * The owner area's frame: a left rail, a top bar, and the page.
 *
 * THE RAIL has three widths, not two. Expanded it shows labels; collapsed it
 * shows icons and keeps the labels as accessible names; below 1024px it is not
 * there at all and a hamburger opens it as a Sheet. A rail that squeezes the
 * ribbon on a laptop is worse than no rail, and the ribbon is what the owner
 * came to look at.
 *
 * THE TIMEZONE CHIP IS ALWAYS VISIBLE. This app is about time; the zone every
 * number on the screen is expressed in is not a setting to go and find.
 *
 * Nothing here decides anything. The layout above it already established who
 * is signed in and which business is theirs.
 */

export function AdminShell({
  businessName,
  timeZone,
  nowInstant,
  user,
  signOutAction,
  banner,
  children,
}: {
  businessName: string;
  timeZone: string;
  /** A server-rendered instant, only so the chip can name the current offset. */
  nowInstant: string;
  user: { name: string; email: string };
  signOutAction: () => Promise<void>;
  /**
   * A permanent strip under the top bar. Server-rendered, so it costs the
   * browser bundle nothing — today it is the demo notice and nothing else.
   */
  banner?: ReactNode;
  children: ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  /**
   * The rail's width is a preference that outlives the page, so it is read
   * from an external store rather than mirrored into component state. See
   * ./rail-collapse-store.ts.
   */
  const collapsed = useSyncExternalStore(
    subscribeToRailCollapse,
    getRailCollapsed,
    getRailCollapsedOnServer,
  );

  return (
    <div className="flex min-h-dvh">
      {/* The rail. Hidden entirely below 1024px — the drawer takes over. */}
      <aside
        className={cn(
          "sticky top-0 hidden h-dvh shrink-0 flex-col gap-6 border-r border-line bg-surface px-3 py-4 lg:flex",
          collapsed ? "w-[4.5rem]" : "w-60",
        )}
      >
        <div
          className={cn(
            "flex items-center gap-2",
            collapsed ? "justify-center" : "justify-between px-2",
          )}
        >
          {!collapsed ? <span className="type-label">{APP_NAME}</span> : null}

          <button
            type="button"
            onClick={() => setRailCollapsed(!collapsed)}
            aria-label={collapsed ? "Expand the menu" : "Collapse the menu"}
            aria-pressed={collapsed}
            className="flex size-9 items-center justify-center rounded-pill text-ink-muted transition-colors hover:bg-surface-sunk hover:text-ink"
          >
            {collapsed ? (
              <PanelLeftOpen aria-hidden="true" className="size-4" />
            ) : (
              <PanelLeftClose aria-hidden="true" className="size-4" />
            )}
          </button>
        </div>

        <AdminNav collapsed={collapsed} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-line bg-surface">
          <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
            <Sheet
              open={drawerOpen}
              onOpenChange={setDrawerOpen}
              side="left"
              title={APP_NAME}
              description={businessName}
              trigger={
                <button
                  type="button"
                  aria-label="Open the menu"
                  className="flex size-9 shrink-0 items-center justify-center rounded-pill text-ink-muted transition-colors hover:bg-surface-sunk hover:text-ink lg:hidden"
                >
                  <Menu aria-hidden="true" className="size-4" />
                </button>
              }
            >
              <AdminNav onNavigate={() => setDrawerOpen(false)} />
            </Sheet>

            <div className="flex min-w-0 flex-1 flex-col">
              <span className="type-label hidden sm:inline">{APP_NAME}</span>
              <span className="type-section truncate text-ink">
                {businessName}
              </span>
            </div>

            <TimezoneChip timeZone={timeZone} instant={nowInstant} />

            <UserMenu
              name={user.name}
              email={user.email}
              signOutAction={signOutAction}
            />
          </div>

          {/* Inside the sticky header, so it does not scroll away. A notice
              that says "none of this is real" is worth nothing the moment it
              is off screen. */}
          {banner}
        </header>

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
