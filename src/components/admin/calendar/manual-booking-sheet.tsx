"use client";

import { ShieldAlert } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/field";
import { PillButton } from "@/components/pill-button";
import { Sheet } from "@/components/sheet";
import { formatInstant } from "@/components/time-text";
import { ToggleField } from "@/components/toggle-switch";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { Textarea } from "@/components/ui/textarea";
import type {
  CalendarServiceOption,
  CalendarStaffOption,
} from "@/lib/admin/calendar";
import { formatCents } from "@/lib/money";
import { createManualBooking } from "@/server/actions/agenda";
import type { FieldErrors } from "@/server/actions/result";

/**
 * Booking somebody in by hand — a phone call, or somebody at the counter.
 *
 * ═══ THE OVERRIDE, SPELLED OUT WHERE IT IS USED ═══
 *
 * The design brief for this screen contains one hard line and the UI has to
 * say it in words rather than imply it:
 *
 *   The override lets the owner ignore LEAD TIME, OPENING HOURS, CLOSURES and
 *   the booking horizon. Those rules exist to stop a stranger booking
 *   something the business cannot honour, and a business working late on a
 *   Tuesday is not a stranger.
 *
 *   The override CANNOT ignore the overlap. Two appointments in one chair is
 *   not a policy — it is arithmetic — and the exclusion constraint in Postgres
 *   refuses it whatever this form sends. There is no flag anywhere in the
 *   codebase that turns it off.
 *
 * That paragraph is on the screen, next to the switch, in the copy below.
 *
 * ═══ WHY AN EMAIL IS REQUIRED ═══
 *
 * A booking with no address cannot be confirmed to anybody, cannot carry a
 * manage link and cannot be reminded — it would exist for the business and not
 * for the customer. An owner who genuinely has no address for a walk-in wants
 * BLOCKED TIME instead: it holds the slot, it says why, and it promises the
 * customer nothing the product cannot deliver. The hint under the field says
 * exactly that, and the block-time sheet is one press away.
 */
export function ManualBookingSheet({
  open,
  onOpenChange,
  services,
  staff,
  currency,
  timeZone,
  /** Local date and time the sheet opens on — usually where the owner tapped. */
  defaultDate,
  defaultStartLocal,
  defaultStaffId,
  onBlockInstead,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  services: CalendarServiceOption[];
  staff: CalendarStaffOption[];
  currency: string;
  timeZone: string;
  defaultDate: string;
  defaultStartLocal: string;
  defaultStaffId: string | null;
  /** "This is really a block, not a booking." */
  onBlockInstead: () => void;
}) {
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [staffId, setStaffId] = useState(defaultStaffId ?? "");
  const [date, setDate] = useState(defaultDate);
  const [startLocal, setStartLocal] = useState(defaultStartLocal);
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerNote, setCustomerNote] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [override, setOverride] = useState(false);
  const [notifyCustomer, setNotifyCustomer] = useState(true);

  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [nearest, setNearest] = useState<{ startsAt: string }[]>([]);
  const [pending, startTransition] = useTransition();

  const service = services.find((candidate) => candidate.id === serviceId);

  /**
   * Only staff who can actually perform this service — UNLESS the override is
   * on, in which case everybody is offered.
   *
   * The assignment table is a statement about who is trained for what, not a
   * law of physics, so it belongs on the same side of the line as opening
   * hours: overridable. The overlap is on the other side.
   */
  const eligible = useMemo(() => {
    if (!service || override) {
      return staff;
    }

    return staff.filter((member) => service.staffIds.includes(member.id));
  }, [service, staff, override]);

  function submit(): void {
    setFormError(null);
    setFieldErrors({});
    setNearest([]);

    startTransition(async () => {
      const result = await createManualBooking({
        serviceId,
        staffId,
        date,
        startLocal,
        customerName,
        customerEmail,
        customerPhone,
        customerNote,
        internalNote,
        override,
        notifyCustomer,
      });

      if (result.ok) {
        toast.success(result.message, { description: result.note });
        onOpenChange(false);
        return;
      }

      setFormError(result.message);
      setFieldErrors(result.fieldErrors ?? {});
      setNearest(result.nearest ?? []);

      /* The refusal that the override WOULD lift says so, right where the
         switch is. The one it would not — an overlap — never sets this. */
      if (result.overridable) {
        toast.error(result.message);
      }
    });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side="right"
      title="Add a booking"
      description="For a phone call or somebody at the counter. No payment is taken."
      footer={
        <div className="flex justify-end gap-3">
          <PillButton
            variant="secondary"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </PillButton>
          <PillButton size="sm" onClick={submit} disabled={pending}>
            {pending ? "Booking…" : "Book it"}
          </PillButton>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {formError ? <FormError>{formError}</FormError> : null}

        {nearest.length > 0 ? (
          <div className="flex flex-col gap-2 rounded-card border border-line bg-surface-sunk/50 p-4">
            <span className="type-label">Times you do offer</span>
            <div className="flex flex-wrap gap-2">
              {nearest.map((offer) => (
                <PillButton
                  key={offer.startsAt}
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    /* Formatting an instant into the business's zone, which is
                       exactly what the client is allowed to do. The date is
                       untouched — every offer came from the day being shown. */
                    setStartLocal(formatInstant(offer.startsAt, timeZone));
                    setNearest([]);
                    setFormError(null);
                  }}
                >
                  {formatInstant(offer.startsAt, timeZone)}
                </PillButton>
              ))}
            </div>
          </div>
        ) : null}

        <Field
          id="manual-service"
          label="Service"
          error={fieldErrors.serviceId}
        >
          {(props) => (
            <SelectNative
              {...props}
              value={serviceId}
              onChange={(event) => setServiceId(event.target.value)}
            >
              {services.length === 0 ? (
                <option value="">No active services</option>
              ) : null}
              {services.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name} · {candidate.durationMin} min ·{" "}
                  {formatCents(candidate.priceCents, currency)}
                </option>
              ))}
            </SelectNative>
          )}
        </Field>

        <Field
          id="manual-staff"
          label="Who is doing it"
          error={fieldErrors.staffId}
          hint={
            !override && service && eligible.length === 0
              ? "Nobody is assigned to this service yet. Turn on the override to book it anyway, or fix the assignment on the Services screen."
              : undefined
          }
        >
          {(props) => (
            <SelectNative
              {...props}
              value={staffId}
              onChange={(event) => setStaffId(event.target.value)}
            >
              <option value="">Pick someone</option>
              {eligible.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </SelectNative>
          )}
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field id="manual-date" label="Date" error={fieldErrors.date}>
            {(props) => (
              <Input
                {...props}
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            )}
          </Field>

          <Field
            id="manual-start"
            label="Start"
            error={fieldErrors.startLocal}
          >
            {(props) => (
              <Input
                {...props}
                type="time"
                value={startLocal}
                onChange={(event) => setStartLocal(event.target.value)}
              />
            )}
          </Field>
        </div>

        <Field
          id="manual-name"
          label="Customer"
          error={fieldErrors.customerName}
        >
          {(props) => (
            <Input
              {...props}
              value={customerName}
              onChange={(event) => setCustomerName(event.target.value)}
              placeholder="Their name"
            />
          )}
        </Field>

        <Field
          id="manual-email"
          label="Email"
          error={fieldErrors.customerEmail}
          hint="Needed for the confirmation and for the link they cancel from. If you have no address for them, block the time out instead of booking it."
        >
          {(props) => (
            <Input
              {...props}
              type="email"
              value={customerEmail}
              onChange={(event) => setCustomerEmail(event.target.value)}
              placeholder="them@example.com"
            />
          )}
        </Field>

        <Field
          id="manual-phone"
          label="Phone"
          optional
          error={fieldErrors.customerPhone}
        >
          {(props) => (
            <Input
              {...props}
              type="tel"
              value={customerPhone}
              onChange={(event) => setCustomerPhone(event.target.value)}
            />
          )}
        </Field>

        <Field id="manual-customer-note" label="What they asked for" optional>
          {(props) => (
            <Textarea
              {...props}
              rows={2}
              value={customerNote}
              onChange={(event) => setCustomerNote(event.target.value)}
              placeholder="Anything they mentioned on the phone."
            />
          )}
        </Field>

        <Field id="manual-internal-note" label="Your note" optional>
          {(props) => (
            <Textarea
              {...props}
              rows={2}
              value={internalNote}
              onChange={(event) => setInternalNote(event.target.value)}
              placeholder="Only you can see this."
            />
          )}
        </Field>

        <ToggleField
          id="manual-notify"
          label="Email them the details"
          description={
            notifyCustomer
              ? "They get the confirmation, the calendar invite and a link to cancel or move it."
              : "Nothing is sent. They will have no link to manage the booking."
          }
          checked={notifyCustomer}
          onCheckedChange={setNotifyCustomer}
        />

        {/* ═══ THE OVERRIDE, AND THE LINE IT CANNOT CROSS ═══ */}
        <div className="flex flex-col gap-3 rounded-card border border-line bg-surface-sunk/50 p-4">
          <ToggleField
            id="manual-override"
            label="Book outside your normal rules"
            description={
              override
                ? "On. Opening hours, blocked time, minimum notice, the booking horizon and who is assigned to the service are all ignored."
                : "Off. This booking has to fit the hours, notice and openings a customer would see."
            }
            checked={override}
            onCheckedChange={setOverride}
            className="border-none bg-transparent px-0 py-0"
          />

          <p className="type-body-sm flex gap-2 border-t border-line pt-3 text-ink-muted">
            <ShieldAlert
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-ink-faint"
            />
            <span>
              It still cannot double-book the same person. Working late is your
              call; being in two chairs at once is not — the database refuses
              overlapping appointments for one staff member whatever this switch
              says.
            </span>
          </p>
        </div>

        <button
          type="button"
          onClick={onBlockInstead}
          className="type-body-sm self-start text-accent underline underline-offset-4"
        >
          Block the time out instead
        </button>
      </div>
    </Sheet>
  );
}
