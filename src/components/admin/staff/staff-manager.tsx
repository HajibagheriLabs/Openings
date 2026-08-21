"use client";

import { AlertTriangle, Pencil, Plus, Trash2, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { PillButton } from "@/components/pill-button";
import { ReorderableList } from "@/components/reorderable-list";
import { StatusBadge } from "@/components/status-badge";
import { ToggleSwitch } from "@/components/toggle-switch";
import { cn } from "@/lib/utils";
import {
  deleteStaff,
  reorderStaff,
  setStaffActive,
} from "@/server/actions/staff";
import type { ServiceRow, StaffRow } from "@/server/queries/catalog";

import { StaffSheet } from "./staff-sheet";

/**
 * The staff screen.
 *
 * DEACTIVATION IS EXPLAINED EVERYWHERE IT APPEARS. The switch's confirmation
 * says the appointments stay, the sheet says it, and the toast says it again
 * afterwards. That repetition is deliberate: "deactivate" reads like "delete"
 * to most people, and this product's whole claim is that it does not lose
 * bookings.
 *
 * The order here is the order of the COLUMNS in the agenda, which is why it is
 * draggable — an owner who always looks at the same person first should not
 * have to scan for them every morning.
 */
export function StaffManager({
  staff,
  services,
}: {
  staff: StaffRow[];
  services: ServiceRow[];
}) {
  const router = useRouter();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<StaffRow | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<StaffRow | null>(null);
  const [confirmingDeactivate, setConfirmingDeactivate] =
    useState<StaffRow | null>(null);
  const [pending, startTransition] = useTransition();
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);

  const ordered = useMemo(() => {
    if (!pendingOrder) {
      return staff;
    }

    const byId = new Map(staff.map((member) => [member.id, member]));

    return pendingOrder
      .map((id) => byId.get(id))
      .filter((member): member is StaffRow => member !== undefined);
  }, [staff, pendingOrder]);

  /**
   * Which services would be left with nobody, if this person switched off.
   *
   * Computed here from data the page already loaded, and advisory only — the
   * server recomputes bookability for the services list either way. It exists
   * so the consequence is visible BEFORE the switch is flipped, rather than
   * discovered later as a flag on another screen.
   */
  function servicesStrandedBy(member: StaffRow): string[] {
    return services
      .filter((service) => {
        const stillActive = service.staff.filter(
          (assignee) => assignee.isActive && assignee.id !== member.id,
        );

        return (
          service.staff.some((assignee) => assignee.id === member.id) &&
          stillActive.length === 0
        );
      })
      .map((service) => service.name);
  }

  function openCreate(): void {
    setEditing(null);
    setSheetOpen(true);
  }

  function openEdit(member: StaffRow): void {
    setEditing(member);
    setSheetOpen(true);
  }

  function handleReorder(orderedIds: string[]): void {
    setPendingOrder(orderedIds);

    startTransition(async () => {
      const result = await reorderStaff(orderedIds);

      if (!result.ok) {
        toast.error(result.message);
      }

      setPendingOrder(null);
    });
  }

  function applyActive(member: StaffRow, isActive: boolean): void {
    startTransition(async () => {
      const result = await setStaffActive(member.id, isActive);

      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  function handleToggleActive(member: StaffRow, isActive: boolean): void {
    // Switching someone ON has no consequences worth a dialog. Switching them
    // OFF can strand a service or affect future bookings, so it asks.
    if (isActive) {
      applyActive(member, true);
      return;
    }

    setConfirmingDeactivate(member);
  }

  function handleDelete(member: StaffRow): void {
    setConfirmingDelete(null);

    startTransition(async () => {
      const result = await deleteStaff(member.id);

      if (result.ok) {
        toast.success(result.message);
        return;
      }

      toast.error(result.message, {
        duration: 12_000,
        action: result.blocked
          ? {
              label: "Show them",
              onClick: () => router.push(result.blocked!.href),
            }
          : undefined,
      });
    });
  }

  const stranded = confirmingDeactivate
    ? servicesStrandedBy(confirmingDeactivate)
    : [];

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Staff"
        title="Staff"
        description="Who takes bookings, and which services each of them performs. The order here is the order of the columns in your agenda."
        actions={
          <PillButton onClick={openCreate}>
            <Plus aria-hidden="true" />
            New staff member
          </PillButton>
        }
      />

      {ordered.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Nobody yet"
          description="Add the people who take bookings. Each one gets a column in the agenda and a set of services they can perform."
          action={
            <PillButton onClick={openCreate}>
              <Plus aria-hidden="true" />
              Add someone
            </PillButton>
          }
        />
      ) : (
        <ReorderableList
          items={ordered}
          onReorder={handleReorder}
          labelFor={(member) => member.name}
          disabled={pending}
          renderItem={(member) => (
            <StaffRowView
              member={member}
              busy={pending}
              onEdit={() => openEdit(member)}
              onToggleActive={(isActive) => handleToggleActive(member, isActive)}
              onDelete={() => setConfirmingDelete(member)}
            />
          )}
        />
      )}

      {/* Keyed like the service sheet: a fresh form per opening. */}
      <StaffSheet
        key={`${editing?.id ?? "new"}:${sheetOpen}`}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        member={editing}
        serviceOptions={services}
      />

      <ConfirmDialog
        open={confirmingDeactivate !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmingDeactivate(null);
          }
        }}
        title={
          confirmingDeactivate
            ? `Stop offering ${confirmingDeactivate.name}?`
            : "Stop offering this person?"
        }
        description="They come off your booking page and out of future availability. Nothing is deleted: every appointment they already have — past and upcoming — stays in the calendar exactly as it is, still theirs."
        confirmLabel="Switch off"
        cancelLabel="Keep them on"
        onConfirm={() => {
          if (confirmingDeactivate) {
            applyActive(confirmingDeactivate, false);
            setConfirmingDeactivate(null);
          }
        }}
      >
        {confirmingDeactivate &&
        (confirmingDeactivate.futureAppointmentCount > 0 ||
          stranded.length > 0) ? (
          <div className="flex flex-col gap-2 rounded-card border border-line bg-surface-sunk/60 px-4 py-3">
            {confirmingDeactivate.futureAppointmentCount > 0 ? (
              <p className="type-body-sm text-ink-muted">
                <span className="text-ink">
                  {confirmingDeactivate.futureAppointmentCount} upcoming
                  appointment
                  {confirmingDeactivate.futureAppointmentCount === 1 ? "" : "s"}
                </span>{" "}
                stay in the calendar and still need doing.
              </p>
            ) : null}

            {stranded.length > 0 ? (
              <p className="type-body-sm text-ink-muted">
                <span className="text-ink">
                  {stranded.join(", ")}
                </span>{" "}
                would have nobody left to perform{" "}
                {stranded.length === 1 ? "it" : "them"}, so{" "}
                {stranded.length === 1 ? "it stops" : "they stop"} being
                bookable.
              </p>
            ) : null}
          </div>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmingDelete(null);
          }
        }}
        title={
          confirmingDelete
            ? `Remove ${confirmingDelete.name}?`
            : "Remove this person?"
        }
        description="Removing deletes the record entirely. If they have ever been booked, the removal is refused and you will be offered the switch instead — an appointment has to keep saying who performed it."
        confirmLabel="Remove"
        cancelLabel="Keep them"
        destructive
        onConfirm={() => {
          if (confirmingDelete) {
            handleDelete(confirmingDelete);
          }
        }}
      />
    </div>
  );
}

/** One row: who they are, what they do, and whether they are being offered. */
function StaffRowView({
  member,
  busy,
  onEdit,
  onToggleActive,
  onDelete,
}: {
  member: StaffRow;
  busy: boolean;
  onEdit: () => void;
  onToggleActive: (isActive: boolean) => void;
  onDelete: () => void;
}) {
  const activeServices = member.services.filter((service) => service.isActive);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-start gap-3">
          {/* The initials as the agenda draws them: carved in, never raised. */}
          <span
            aria-hidden="true"
            className="type-time inline-flex size-11 shrink-0 items-center justify-center rounded-segment bg-surface-sunk text-ink-muted shadow-inset"
          >
            {member.initials}
          </span>

          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="type-section text-ink">{member.name}</h2>
              {!member.isActive ? (
                <StatusBadge tone="neutral">Not offered</StatusBadge>
              ) : null}
            </div>

            {member.email ? (
              <p className="type-body-sm truncate text-ink-muted">
                {member.email}
              </p>
            ) : (
              <p className="type-body-sm text-ink-faint">No email on file</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <ToggleSwitch
            checked={member.isActive}
            onCheckedChange={onToggleActive}
            disabled={busy}
            label={`${member.name} takes bookings`}
          />

          <PillButton
            variant="secondary"
            size="icon-sm"
            onClick={onEdit}
            aria-label={`Edit ${member.name}`}
          >
            <Pencil aria-hidden="true" />
          </PillButton>

          <PillButton
            variant="quiet"
            size="icon-sm"
            onClick={onDelete}
            disabled={busy}
            aria-label={`Remove ${member.name}`}
          >
            <Trash2 aria-hidden="true" />
          </PillButton>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="type-label">Performs</span>

        {member.services.length === 0 ? (
          <span className="type-body-sm text-ink-muted">Nothing yet</span>
        ) : (
          member.services.map((service) => (
            <span
              key={service.id}
              className={cn(
                "type-body-sm inline-flex h-7 items-center rounded-pill border border-line bg-surface-sunk px-3",
                service.isActive
                  ? "text-ink-muted"
                  : "text-ink-faint line-through",
              )}
            >
              {service.name}
            </span>
          ))
        )}
      </div>

      {member.isActive && activeServices.length === 0 ? (
        <p className="type-body-sm flex items-start gap-3 rounded-card border border-line bg-surface-sunk/60 px-4 py-3 text-ink-muted">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            {member.name} is offered but performs no bookable service, so no
            customer can reach them. Assign at least one.
          </span>
        </p>
      ) : null}

      {!member.isActive && member.futureAppointmentCount > 0 ? (
        <p className="type-body-sm rounded-card border border-line bg-surface-sunk/60 px-4 py-3 text-ink-muted">
          Not offered for new bookings.{" "}
          <span className="text-ink">
            {member.futureAppointmentCount} upcoming appointment
            {member.futureAppointmentCount === 1 ? "" : "s"}
          </span>{" "}
          still stand in the calendar.
        </p>
      ) : null}
    </div>
  );
}
