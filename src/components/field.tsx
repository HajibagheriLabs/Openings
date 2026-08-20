import type { ReactNode } from "react";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Label, control, hint, error — wired together.
 *
 * The wiring is the point. The hint and the error are referenced from the
 * control through `aria-describedby`, and the error also flips `aria-invalid`,
 * so a screen reader hears what went wrong at the moment focus lands on the
 * field rather than never. Every form in the owner area uses this, which is
 * how that stays true.
 */
export function Field({
  id,
  label,
  hint,
  error,
  optional,
  children,
  className,
}: {
  /** Must match the control's own id. */
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  /** Render the control, given the ids it has to carry. */
  children: (controlProps: {
    id: string;
    "aria-describedby": string | undefined;
    "aria-invalid": boolean | undefined;
  }) => ReactNode;
  className?: string;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={id} className="type-section text-ink">
          {label}
        </Label>
        {optional ? <span className="type-label">Optional</span> : null}
      </div>

      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
      })}

      {hint ? (
        <p id={hintId} className="type-body-sm text-ink-muted">
          {hint}
        </p>
      ) : null}

      {error ? (
        <p id={errorId} className="type-body-sm text-cancelled">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The form-level message.
 *
 * `role="alert"` because it appears after a submit the person has already
 * stopped looking at the form to make — it has to interrupt, not wait to be
 * discovered.
 */
export function FormError({ children }: { children: ReactNode }) {
  if (!children) {
    return null;
  }

  return (
    <p
      role="alert"
      className="type-body-sm rounded-card border border-cancelled/40 bg-cancelled/10 px-4 py-3 text-cancelled"
    >
      {children}
    </p>
  );
}
