"use client";

import { Switch } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * On or off, for the one setting per row that is genuinely binary.
 *
 * Radix Switch underneath, so it is a real `role="switch"` with a real checked
 * state rather than a styled div — a screen reader hears "Bookable, switch,
 * on", which is the whole reason to use a switch instead of a checkbox here.
 *
 * The accent is spent on the ON state and nothing else on this component.
 * OFF is the sunk surface: quieter, and legible without relying on hue, since
 * the knob's position carries the same information.
 *
 * No transition on the knob. Motion in Daybook is reserved for the hold
 * countdown and a slot being taken; a switch is not an event worth animating.
 */
export function ToggleSwitch({
  id,
  checked,
  onCheckedChange,
  disabled,
  label,
  describedBy,
  className,
}: {
  id?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** The accessible name when no visible <label> points at this control. */
  label?: string;
  /** Id of the text that explains what switching it does. */
  describedBy?: string;
  className?: string;
}) {
  return (
    <Switch.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      aria-describedby={describedBy}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-pill border p-0.5",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked
          ? "border-accent bg-accent"
          : "border-line-strong bg-surface-sunk",
        className,
      )}
    >
      <Switch.Thumb
        className={cn(
          "block size-4.5 rounded-pill bg-surface",
          checked ? "translate-x-5" : "translate-x-0",
        )}
      />
    </Switch.Root>
  );
}

/**
 * The switch with its label and its consequence spelled out.
 *
 * The description changes with the state on purpose. "Active" tells the owner
 * nothing; "Customers can book this" and "Hidden from your booking page.
 * Existing appointments are unchanged" tell them what the switch just did, at
 * the moment they are looking at it.
 */
export function ToggleField({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  className,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 rounded-card border border-line bg-surface-sunk/50 px-4 py-3",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={id} className="type-section text-ink">
          {label}
        </label>
        {description ? (
          <p id={`${id}-description`} className="type-body-sm text-ink-muted">
            {description}
          </p>
        ) : null}
      </div>

      <ToggleSwitch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        describedBy={description ? `${id}-description` : undefined}
        className="mt-0.5"
      />
    </div>
  );
}
