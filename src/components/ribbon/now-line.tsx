"use client";

import { offsetPx, type RibbonWindow } from "./scale";

/**
 * Where "now" falls on the strip.
 *
 * Deliberately NOT in the accent. Verdigris means open time, primary actions,
 * focus and the selected slot, and nothing else — spending it on a clock hand
 * would blunt the one signal the ribbon depends on. This is drawn in --ink at
 * full value instead, which reads as the darkest thing on a quiet surface and
 * needs no colour at all to be found.
 *
 * `nowMinute` is minutes since local midnight, resolved on the server in the
 * business's timezone. The line does not know what time it is and never asks.
 */
export function NowLine({
  nowMinute,
  window,
  pxPerMin,
}: {
  nowMinute: number;
  window: RibbonWindow;
  pxPerMin: number;
}) {
  if (nowMinute < window.startMinute || nowMinute > window.endMinute) {
    return null;
  }

  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-10 flex items-center"
      style={{ top: offsetPx(nowMinute, window, pxPerMin) }}
    >
      <span
        aria-hidden="true"
        className="-ml-1 size-2 shrink-0 rounded-pill bg-ink"
      />
      <span aria-hidden="true" className="h-px flex-1 bg-ink" />
      <span className="type-label ml-2 shrink-0 bg-surface px-1 text-ink">
        Now
      </span>
    </div>
  );
}
