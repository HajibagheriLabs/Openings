"use client";

import { AlertTriangle, Pencil, Plus, Scissors, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { DurationChip } from "@/components/duration-chip";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { PillButton } from "@/components/pill-button";
import { ReorderableList } from "@/components/reorderable-list";
import { StatusBadge } from "@/components/status-badge";
import { ToggleSwitch } from "@/components/toggle-switch";
import { describeDeposit, formatCents } from "@/lib/money";
import { blockedMinutes } from "@/lib/scheduling/blocked-time";
import { UNBOOKABLE_COPY } from "@/lib/scheduling/bookability";
import { cn } from "@/lib/utils";
import {
  deleteService,
  reorderServices,
  setServiceActive,
} from "@/server/actions/services";
import type { ServiceRow, StaffSummary } from "@/server/queries/catalog";

import { ServiceSheet } from "./service-sheet";

/**
 * The services screen.
 *
 * Everything on this page is REAL DATA and every change goes through a
 * validated Server Action. The list is the owner's menu in the order customers
 * will see it, which is why the order is draggable and why it is stored rather
 * than derived.
 *
 * A service that cannot be booked is FLAGGED HERE rather than quietly dropped.
 * The failure this prevents is the specific one: an owner adds a service,
 * forgets to assign anyone to it, and it never appears on the booking page —
 * with the admin screen showing it exactly like the ones that work.
 */
export function ServicesManager({
  services,
  staff,
  currency,
  slotGranularityMin,
}: {
  services: ServiceRow[];
  staff: StaffSummary[];
  currency: string;
  slotGranularityMin: number;
}) {
  const router = useRouter();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<ServiceRow | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<ServiceRow | null>(
    null,
  );
  const [pending, startTransition] = useTransition();

  /**
   * The order the owner just dragged into, held locally until the server
   * agrees.
   *
   * Reordering has to feel instant — a row that snaps back for 200ms while a
   * round trip completes reads as a failed drag. On success this is cleared
   * and the server's order takes over; on failure it is cleared too, so the
   * list visibly returns to the truth rather than lying.
   */
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);

  const ordered = useMemo(() => {
    if (!pendingOrder) {
      return services;
    }

    const byId = new Map(services.map((service) => [service.id, service]));

    return pendingOrder
      .map((id) => byId.get(id))
      .filter((service): service is ServiceRow => service !== undefined);
  }, [services, pendingOrder]);

  const unbookableCount = ordered.filter(
    (service) => !service.bookability.bookable,
  ).length;

  function openCreate(): void {
    setEditing(null);
    setSheetOpen(true);
  }

  function openEdit(service: ServiceRow): void {
    setEditing(service);
    setSheetOpen(true);
  }

  function handleReorder(orderedIds: string[]): void {
    setPendingOrder(orderedIds);

    startTransition(async () => {
      const result = await reorderServices(orderedIds);

      if (!result.ok) {
        toast.error(result.message);
      }

      // Cleared either way: the server-rendered list is now the truth, whether
      // it accepted the move or refused it.
      setPendingOrder(null);
    });
  }

  function handleToggleActive(service: ServiceRow, isActive: boolean): void {
    startTransition(async () => {
      const result = await setServiceActive(service.id, isActive);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  function handleDelete(service: ServiceRow): void {
    setConfirmingDelete(null);

    startTransition(async () => {
      const result = await deleteService(service.id);

      if (result.ok) {
        toast.success(result.message);
        return;
      }

      /**
       * A refusal with somewhere to go.
       *
       * The server counted the appointments; the toast repeats the count and
       * offers the way to look at them. A refusal that only says "no" leaves
       * the owner to guess how much history is in the way.
       */
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

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Services"
        title="Services"
        description="What customers can book, how long each takes, and what it costs. Drag to change the order they appear in on your booking page."
        actions={
          <PillButton onClick={openCreate}>
            <Plus aria-hidden="true" />
            New service
          </PillButton>
        }
      />

      {unbookableCount > 0 ? (
        <p
          role="status"
          className="type-body-sm flex items-start gap-3 rounded-card border border-pending/40 bg-pending/10 px-4 py-3 text-pending"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            {unbookableCount === 1
              ? "One service is not bookable and does not appear on your booking page."
              : `${unbookableCount} services are not bookable and do not appear on your booking page.`}{" "}
            Each one says why below.
          </span>
        </p>
      ) : null}

      {ordered.length === 0 ? (
        <EmptyState
          icon={Scissors}
          title="No services yet"
          description="A service is one thing a customer can book: its length, its price, and who can perform it."
          action={
            <PillButton onClick={openCreate}>
              <Plus aria-hidden="true" />
              Add your first service
            </PillButton>
          }
        />
      ) : (
        <ReorderableList
          items={ordered}
          onReorder={handleReorder}
          labelFor={(service) => service.name}
          disabled={pending}
          renderItem={(service) => (
            <ServiceRowView
              service={service}
              currency={currency}
              slotGranularityMin={slotGranularityMin}
              busy={pending}
              onEdit={() => openEdit(service)}
              onToggleActive={(isActive) => handleToggleActive(service, isActive)}
              onDelete={() => setConfirmingDelete(service)}
            />
          )}
        />
      )}

      {/* Keyed on which service is open AND on whether it is open at all, so
          every opening mounts a fresh form seeded from current data. Without
          the key the sheet would keep whatever was typed into it last time. */}
      <ServiceSheet
        key={`${editing?.id ?? "new"}:${sheetOpen}`}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        service={editing}
        staffOptions={staff}
        currency={currency}
        slotGranularityMin={slotGranularityMin}
      />

      <ConfirmDialog
        open={confirmingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmingDelete(null);
          }
        }}
        title={
          confirmingDelete ? `Delete ${confirmingDelete.name}?` : "Delete service?"
        }
        description="Deleting removes the service from your menu for good. If anyone has ever booked it, the deletion is refused and you will be offered the switch instead — history is never rewritten to tidy a list."
        confirmLabel="Delete"
        cancelLabel="Keep it"
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

/** One row: what it is, what it costs the day, and who can do it. */
function ServiceRowView({
  service,
  currency,
  slotGranularityMin,
  busy,
  onEdit,
  onToggleActive,
  onDelete,
}: {
  service: ServiceRow;
  currency: string;
  slotGranularityMin: number;
  busy: boolean;
  onEdit: () => void;
  onToggleActive: (isActive: boolean) => void;
  onDelete: () => void;
}) {
  const total = blockedMinutes(service);
  const deposit = describeDeposit(service, currency);
  const activeStaff = service.staff.filter((member) => member.isActive);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="type-section text-ink">{service.name}</h2>
            {!service.bookability.bookable ? (
              <StatusBadge tone="pending">Not bookable</StatusBadge>
            ) : null}
          </div>

          {service.description ? (
            <p className="type-body-sm max-w-[60ch] text-ink-muted">
              {service.description}
            </p>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          {/* The switch is the reversible action, so it sits closest to hand;
              delete is the quiet icon beside it, and asks first. */}
          <ToggleSwitch
            checked={service.isActive}
            onCheckedChange={onToggleActive}
            disabled={busy}
            label={`${service.name} is bookable`}
          />

          <PillButton
            variant="secondary"
            size="icon-sm"
            onClick={onEdit}
            aria-label={`Edit ${service.name}`}
          >
            <Pencil aria-hidden="true" />
          </PillButton>

          <PillButton
            variant="quiet"
            size="icon-sm"
            onClick={onDelete}
            disabled={busy}
            aria-label={`Delete ${service.name}`}
          >
            <Trash2 aria-hidden="true" />
          </PillButton>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <DurationChip minutes={service.durationMin} />

        {/* The number that matters operationally, spelled out rather than
            left for the owner to add up from two buffer fields. */}
        {total !== service.durationMin ? (
          <span className="type-body-sm text-ink-muted">
            {total} min of the day
            {service.bufferBeforeMin > 0
              ? `, ${service.bufferBeforeMin} before`
              : ""}
            {service.bufferAfterMin > 0
              ? `, ${service.bufferAfterMin} after`
              : ""}
          </span>
        ) : (
          <span className="type-body-sm text-ink-faint">No buffers</span>
        )}

        <span className="type-time text-ink">
          {formatCents(service.priceCents, currency)}
        </span>

        {deposit ? (
          <span className="type-body-sm text-ink-muted">{deposit}</span>
        ) : (
          <span className="type-body-sm text-ink-faint">No deposit</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="type-label">Performed by</span>

        {service.staff.length === 0 ? (
          <span className="type-body-sm text-ink-muted">Nobody yet</span>
        ) : (
          service.staff.map((member) => (
            <span
              key={member.id}
              title={member.name}
              className={cn(
                "type-body-sm inline-flex h-7 items-center gap-2 rounded-pill border px-3",
                member.isActive
                  ? "border-line bg-surface-sunk text-ink-muted"
                  : "border-line bg-surface-sunk text-ink-faint line-through",
              )}
            >
              {member.name}
            </span>
          ))
        )}

        {service.staff.length > 0 && activeStaff.length === 0 ? (
          <span className="type-body-sm text-ink-faint">
            (all switched off)
          </span>
        ) : null}
      </div>

      {/* Why it is not bookable, and what to do about it. Never just a badge. */}
      {!service.bookability.bookable ? (
        <ul className="flex flex-col gap-1 rounded-card border border-line bg-surface-sunk/60 px-4 py-3">
          {service.bookability.reasons.map((reason) => (
            <li key={reason} className="type-body-sm text-ink-muted">
              <span className="text-ink">{UNBOOKABLE_COPY[reason].summary}.</span>{" "}
              {reason === "off-grid"
                ? `Your booking interval is ${slotGranularityMin} minutes; ${service.durationMin} is not a multiple of it.`
                : UNBOOKABLE_COPY[reason].fix}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
