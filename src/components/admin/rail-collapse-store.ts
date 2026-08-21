/**
 * Whether the admin rail is collapsed, kept in localStorage.
 *
 * A tiny external store rather than `useState` plus an effect that reads
 * localStorage on mount. The preference genuinely lives OUTSIDE React — it
 * outlives the page, and two tabs can disagree about it — which is exactly
 * what `useSyncExternalStore` is for. Setting state from an effect to catch up
 * with it would render twice on every load and shift the layout while the
 * owner watches.
 *
 * `getServerSnapshot` returns false, so the server always renders the expanded
 * rail and React swaps in the stored value at hydration without a mismatch.
 */

const STORAGE_KEY = "openings.rail-collapsed";

const listeners = new Set<() => void>();

export function subscribeToRailCollapse(listener: () => void): () => void {
  listeners.add(listener);

  // Another tab changing the preference fires this; the same tab does not,
  // which is why setRailCollapsed notifies by hand.
  globalThis.addEventListener?.("storage", listener);

  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", listener);
  };
}

export function getRailCollapsed(): boolean {
  return globalThis.localStorage?.getItem(STORAGE_KEY) === "1";
}

/** The rail starts expanded on the server, every time. */
export function getRailCollapsedOnServer(): boolean {
  return false;
}

export function setRailCollapsed(collapsed: boolean): void {
  globalThis.localStorage?.setItem(STORAGE_KEY, collapsed ? "1" : "0");

  for (const listener of listeners) {
    listener();
  }
}
