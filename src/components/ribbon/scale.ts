/**
 * THE SCALE. This is where the Ribbon's proportions are configured.
 *
 * Time is drawn as a continuous strip of material at a FIXED number of pixels
 * per minute, so a 90-minute service physically occupies three times the space
 * of a 30-minute one. That proportionality is the whole idea: the day is a
 * quantity of material, and booking subtracts from it.
 *
 * The same scale renders the customer's day picker and the admin's agenda.
 * Only the number of columns changes. Change `DEFAULT_PX_PER_MIN` and both
 * move together; pass `pxPerMin` to a single <Ribbon> to override it there.
 *
 * Nothing in this file knows what a date is. It converts minutes to pixels.
 */

/**
 * 1.6px per minute. An hour is 96px, a 15-minute slot is 24px, a working day
 * of ten hours is 960px — tall enough that scrolling is expected and the
 * proportions stay readable on a phone.
 */
export const DEFAULT_PX_PER_MIN = 1.6;

/**
 * The smallest thing a finger can reliably hit, per WCAG 2.5.5 and every
 * platform HIG.
 *
 * A 15-minute slot is 24px at the default scale, which is honest but
 * untappable. The Ribbon keeps the VISUAL height truthful and quietly extends
 * the HIT AREA to reach this number — the drawing must not lie about how much
 * of the day a slot occupies, and the target must not be too small to press.
 */
export const MIN_TOUCH_TARGET_PX = 44;

/** Minutes between hour gridlines. */
export const MINUTES_PER_HOUR = 60;

/** Minutes between the lighter intermediate gridlines. */
export const MINUTES_PER_HALF_HOUR = 30;

/**
 * The slice of the day the Ribbon draws, in MINUTES SINCE LOCAL MIDNIGHT in
 * the business's timezone.
 *
 * Local minutes, not instants: the caller resolves "the day" on the server,
 * in the right zone, and hands over plain numbers. A window of 480 → 1200 is
 * 08:00 to 20:00.
 */
export interface RibbonWindow {
  startMinute: number;
  endMinute: number;
}

/** Total minutes in a window. */
export function windowDuration(window: RibbonWindow): number {
  return window.endMinute - window.startMinute;
}

/** Distance in pixels from the top of the ribbon to a given local minute. */
export function offsetPx(
  minute: number,
  window: RibbonWindow,
  pxPerMin: number,
): number {
  return (minute - window.startMinute) * pxPerMin;
}

/** Height in pixels of a span of minutes. */
export function lengthPx(minutes: number, pxPerMin: number): number {
  return minutes * pxPerMin;
}

/** Full drawn height of the ribbon body. */
export function bodyHeightPx(window: RibbonWindow, pxPerMin: number): number {
  return lengthPx(windowDuration(window), pxPerMin);
}

/**
 * How far a segment's hit area has to reach beyond its drawn box, on each
 * edge, to make a `MIN_TOUCH_TARGET_PX` target. Zero when the segment is
 * already tall enough.
 */
export function hitAreaInsetPx(visualHeightPx: number): number {
  if (visualHeightPx >= MIN_TOUCH_TARGET_PX) {
    return 0;
  }

  return (MIN_TOUCH_TARGET_PX - visualHeightPx) / 2;
}

/**
 * The local minutes at which gridlines fall inside a window.
 *
 * Both series start at the first multiple of their step at or after the
 * window start, so a window beginning at 08:20 still rules its lines on the
 * clock rather than on the window edge.
 */
export function gridlineMinutes(
  window: RibbonWindow,
  stepMinutes: number,
): number[] {
  const first = Math.ceil(window.startMinute / stepMinutes) * stepMinutes;
  const lines: number[] = [];

  for (let minute = first; minute <= window.endMinute; minute += stepMinutes) {
    lines.push(minute);
  }

  return lines;
}
