import { FlaskConical } from "lucide-react";

/**
 * "Demo workspace — bookings here are not real."
 *
 * ═══ PERSISTENT, AND NOT DISMISSIBLE ═══
 *
 * It sits under the top bar on every owner screen and stays there. A banner
 * with an X is a banner somebody closes in the first ten seconds and then
 * spends twenty minutes forgetting — and the one thing this workspace must
 * never do is let a person believe a real customer is arriving on Thursday.
 * It is quiet enough to work underneath and permanent enough to be believed.
 *
 * NOT A --pending TOAST COLOUR. The system-state colours mean something
 * specific in this product (a held appointment, a failed delivery), and
 * spending one on a permanent piece of chrome would blunt it everywhere else.
 * This is a sunk surface and a hairline, like every other quiet panel.
 */
export function DemoBanner() {
  return (
    <div
      role="status"
      className="border-b border-line bg-surface-sunk px-4 py-2.5 sm:px-6"
    >
      <p className="type-body-sm flex items-start gap-2 text-ink-muted">
        <FlaskConical
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-ink-faint"
        />
        <span>
          <strong className="font-semibold text-ink">Demo workspace</strong> —
          bookings here are not real. Change anything you like: block time out,
          cancel something, add a booking by hand. The business itself, its
          staff and its services stay put so the next visitor finds a working
          diary.
        </span>
      </p>
    </div>
  );
}
