"use client";

import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The `service_staff` editor — the same control, pointed either way.
 *
 * On the service sheet it lists people and asks who can perform this. On the
 * staff sheet it lists services and asks what this person does. The link table
 * has no direction, so neither should the control: one component, two labels,
 * and no chance of the two screens disagreeing about what a selection means.
 *
 * Chips rather than checkboxes. The set is small, the answer is usually "most
 * of them", and a row of pills reads at a glance in a way a column of
 * checkboxes does not.
 *
 * `aria-pressed` rather than a checkbox role: these are toggle buttons, and
 * the group is labelled by the surrounding Field.
 */

export interface AssignmentOption {
  id: string;
  label: string;
  /** Rendered small and quiet after the label — initials, or a duration. */
  meta?: string;
  /**
   * Inactive options stay selectable. An owner assigning a service to someone
   * who is currently switched off is doing something legitimate — preparing
   * for their return — and the chip says so rather than hiding the option.
   */
  isInactive?: boolean;
}

export function AssignmentPicker({
  id,
  label,
  options,
  selectedIds,
  onChange,
  emptyMessage,
  describedBy,
  className,
}: {
  id?: string;
  /**
   * The group's accessible name, carried on the group itself.
   *
   * A `<label for>` cannot name a group — `for` only binds to form controls —
   * so repeating the visible label here is what stops this from reaching a
   * screen reader as an anonymous pile of toggle buttons.
   */
  label: string;
  options: AssignmentOption[];
  selectedIds: string[];
  onChange: (next: string[]) => void;
  /** Shown instead of the chips when there is nothing to assign. */
  emptyMessage: string;
  /**
   * Ids of the hint and the error, from the surrounding Field.
   *
   * The error reaches a screen reader through here rather than through
   * `aria-invalid`: `role="group"` does not support that attribute, and a
   * group is not a control that can be in an invalid state. The message being
   * part of the group's description is what actually gets it announced.
   */
  describedBy?: string;
  className?: string;
}) {
  if (options.length === 0) {
    return (
      <p
        id={id}
        className="type-body-sm rounded-card border border-dashed border-line px-4 py-3 text-ink-muted"
      >
        {emptyMessage}
      </p>
    );
  }

  const selected = new Set(selectedIds);

  function toggle(optionId: string): void {
    const next = new Set(selected);

    if (next.has(optionId)) {
      next.delete(optionId);
    } else {
      next.add(optionId);
    }

    // Emitted in the options' own order, so the array never depends on the
    // order the owner happened to click in.
    onChange(options.filter((option) => next.has(option.id)).map((o) => o.id));
  }

  return (
    <div
      id={id}
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
      className={cn("flex flex-wrap gap-2", className)}
    >
      {options.map((option) => {
        const isSelected = selected.has(option.id);

        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={isSelected}
            onClick={() => toggle(option.id)}
            className={cn(
              "type-body-sm inline-flex h-11 items-center gap-2 rounded-pill border px-4 transition-colors",
              isSelected
                ? "border-accent bg-accent text-accent-contrast"
                : "border-line bg-surface text-ink-muted hover:bg-surface-sunk hover:text-ink",
            )}
          >
            {/* The tick is the second signal, so selection is not only colour. */}
            <Check
              aria-hidden="true"
              className={cn("size-4", isSelected ? "opacity-100" : "opacity-0")}
            />
            <span className="font-medium">{option.label}</span>
            {option.meta ? (
              <span
                className={cn(
                  "type-label",
                  isSelected ? "text-accent-contrast/70" : "text-ink-faint",
                )}
              >
                {option.meta}
              </span>
            ) : null}
            {option.isInactive ? (
              <span
                className={cn(
                  "type-label",
                  isSelected ? "text-accent-contrast/70" : "text-ink-faint",
                )}
              >
                Off
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
