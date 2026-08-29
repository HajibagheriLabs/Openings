import type { AppointmentStatus } from "@/db/schema";
import { cn } from "@/lib/utils";

/**
 * The one place the system-state colours are allowed.
 *
 * --confirmed, --pending and --cancelled are CHROME ONLY: status badges and
 * toasts in the admin area. They must never appear on the ribbon, where state
 * is carried by fill, pattern and value so that it survives colourblindness.
 * Putting a green pill on a segment would undo the whole encoding.
 *
 * Even here the colour is not alone: every badge carries a dot AND a word.
 */

export type StatusTone = "confirmed" | "pending" | "cancelled" | "neutral";

/**
 * ═══ THE FILL IS --surface, NOT A TINT OF THE TONE ═══
 *
 * These used to be `bg-confirmed/10`, which is a translucent tint — so the
 * colour underneath it decided what the word was actually printed on. On a
 * white row "Confirmed" measured 5.0:1; on the sunk fill of a past row the
 * same badge measured 3.4:1 and failed AA, purely because of what it happened
 * to be sitting on. A chip that changes legibility depending on the row is a
 * chip that cannot be reasoned about.
 *
 * An opaque --surface fill fixes it once, everywhere, and it is the more
 * honest shape anyway: a badge is a small piece of material laid on the page,
 * with a hairline round it and the state written in colour. The tone is still
 * carried by the border and the word, and the word is still there for anybody
 * who cannot see either.
 */
const TONE_CLASSES: Record<StatusTone, string> = {
  confirmed: "border-confirmed/40 bg-surface text-confirmed",
  pending: "border-pending/40 bg-surface text-pending",
  cancelled: "border-cancelled/40 bg-surface text-cancelled",
  neutral: "border-line bg-surface text-ink-muted",
};

/**
 * Appointment lifecycle to badge.
 *
 * `held` is pending because that is exactly what it is — a slot reserved for
 * eight minutes while somebody finds their card. `no_show` is not cancelled:
 * the business kept the time and lost it, which is a different fact and
 * eventually a different report.
 */
const STATUS_TONE: Record<AppointmentStatus, StatusTone> = {
  held: "pending",
  confirmed: "confirmed",
  completed: "neutral",
  cancelled: "cancelled",
  no_show: "cancelled",
};

const STATUS_LABEL: Record<AppointmentStatus, string> = {
  held: "Held",
  confirmed: "Confirmed",
  completed: "Done",
  cancelled: "Cancelled",
  no_show: "No-show",
};

export function StatusBadge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: StatusTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "type-body-sm inline-flex h-7 items-center gap-2 rounded-pill border px-3 font-medium",
        TONE_CLASSES[tone],
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-pill bg-current"
      />
      {children}
    </span>
  );
}

/** The badge for an appointment row, given its status. */
export function AppointmentStatusBadge({
  status,
  className,
}: {
  status: AppointmentStatus;
  className?: string;
}) {
  return (
    <StatusBadge tone={STATUS_TONE[status]} className={className}>
      {STATUS_LABEL[status]}
    </StatusBadge>
  );
}
