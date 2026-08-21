"use client";

import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A list whose order is the data.
 *
 * DRAGGING IS THE SECOND WAY TO DO THIS, NOT THE ONLY ONE. Native HTML5 drag
 * and drop does not fire on touch at all, and it is invisible to a keyboard,
 * so a list that only drags is a list that only a mouse can reorder — on a
 * product whose owner is as likely to be on a phone behind the counter as at a
 * desk. Every row therefore carries a real pair of move buttons, and those
 * buttons are the primary mechanism: they work with a finger, with a keyboard,
 * and with a screen reader, and they announce what they did.
 *
 * Dragging is layered on top for the mouse, using the platform's own drag
 * events rather than a library — the list is short, the rows are simple, and
 * a drag library would be a dependency and a bundle for an interaction the
 * browser already implements.
 *
 * This component owns NO order. It reports the new sequence and the caller
 * decides what to do about it, so the same list can be optimistic, pessimistic
 * or read-only without this file knowing.
 */

export interface ReorderableItem {
  id: string;
}

export function ReorderableList<T extends ReorderableItem>({
  items,
  onReorder,
  labelFor,
  renderItem,
  disabled,
  className,
}: {
  items: T[];
  /** The complete new order, ids first to last. */
  onReorder: (orderedIds: string[]) => void;
  /** "Cut and finish" — used in the move buttons' accessible names. */
  labelFor: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  /** The row being dragged, by id. Null when nothing is in flight. */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** The row the pointer is currently over, so it can show where the drop lands. */
  const [overId, setOverId] = useState<string | null>(null);

  /**
   * The controls are RENDERED whenever there is more than one row, and merely
   * DISABLED while a mutation is in flight.
   *
   * Hiding them instead would make every handle in the list vanish and come
   * back each time the owner flips an unrelated switch — the rows would jump
   * sideways mid-interaction. A control that greys out has clearly been
   * suspended; a control that disappears looks like a bug.
   */
  const hasControls = items.length > 1;
  const canDrag = hasControls && !disabled;

  function move(fromIndex: number, toIndex: number): void {
    if (
      fromIndex === toIndex ||
      toIndex < 0 ||
      toIndex >= items.length ||
      fromIndex < 0
    ) {
      return;
    }

    const next = items.slice();
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);

    onReorder(next.map((item) => item.id));
  }

  function handleDrop(targetId: string): void {
    if (!draggingId || draggingId === targetId) {
      return;
    }

    move(
      items.findIndex((item) => item.id === draggingId),
      items.findIndex((item) => item.id === targetId),
    );
  }

  return (
    <ul className={cn("flex flex-col gap-3", className)}>
      {items.map((item, index) => {
        const isDragging = draggingId === item.id;
        const isOver = overId === item.id && draggingId !== item.id;

        return (
          <li
            key={item.id}
            draggable={canDrag}
            onDragStart={(event) => {
              setDraggingId(item.id);
              event.dataTransfer.effectAllowed = "move";
              // Firefox refuses to start a drag without payload on the transfer.
              event.dataTransfer.setData("text/plain", item.id);
            }}
            onDragEnd={() => {
              setDraggingId(null);
              setOverId(null);
            }}
            onDragOver={(event) => {
              if (!canDrag || !draggingId) {
                return;
              }
              // Without preventDefault the browser refuses the drop outright.
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setOverId(item.id);
            }}
            onDragLeave={() => setOverId((current) =>
              current === item.id ? null : current,
            )}
            onDrop={(event) => {
              event.preventDefault();
              handleDrop(item.id);
              setDraggingId(null);
              setOverId(null);
            }}
            className={cn(
              "flex items-stretch gap-3 rounded-card border border-line bg-surface",
              // The drop target is marked with the accent hairline the rest of
              // the product uses for "this is the one you are choosing".
              isOver && "border-accent",
              isDragging && "opacity-60",
            )}
          >
            {hasControls ? (
              <div className="flex flex-col items-center justify-center gap-0.5 border-r border-line px-1 py-2">
                <button
                  type="button"
                  onClick={() => move(index, index - 1)}
                  disabled={disabled || index === 0}
                  aria-label={`Move ${labelFor(item)} up`}
                  className="flex size-8 items-center justify-center rounded-pill text-ink-faint transition-colors hover:bg-surface-sunk hover:text-ink disabled:pointer-events-none disabled:opacity-30"
                >
                  <ChevronUp aria-hidden="true" className="size-4" />
                </button>

                {/* Decorative: the affordance for the drag the <li> handles.
                    It is not a button, because it does nothing a button could
                    do that the two chevrons do not already do accessibly. */}
                <GripVertical
                  aria-hidden="true"
                  className={cn(
                    "size-4 text-ink-faint",
                    canDrag ? "cursor-grab" : "opacity-30",
                  )}
                />

                <button
                  type="button"
                  onClick={() => move(index, index + 1)}
                  disabled={disabled || index === items.length - 1}
                  aria-label={`Move ${labelFor(item)} down`}
                  className="flex size-8 items-center justify-center rounded-pill text-ink-faint transition-colors hover:bg-surface-sunk hover:text-ink disabled:pointer-events-none disabled:opacity-30"
                >
                  <ChevronDown aria-hidden="true" className="size-4" />
                </button>
              </div>
            ) : null}

            <div className="min-w-0 flex-1">{renderItem(item, index)}</div>
          </li>
        );
      })}
    </ul>
  );
}
