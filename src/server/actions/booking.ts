"use server";

import { z } from "zod";

import { db } from "@/db";
import { ANY_STAFF, LOCAL_DATE_PATTERN } from "@/lib/booking/url";
import type {
  RefreshDayResult,
  ReleaseSlotResult,
  TakeSlotResult,
} from "@/lib/booking/hold";
import {
  createHold,
  moveHold,
  releaseHoldByToken,
  SlotTakenError,
  ServiceNotFoundError,
} from "@/lib/scheduling/booking";
import { nearestOffers } from "@/lib/scheduling/day-view";
import {
  clearHoldCookie,
  readHoldCookie,
  writeHoldCookie,
} from "@/server/booking/hold-cookie";
import {
  loadPickerSnapshot,
  readHoldFor,
  resolvePicker,
  toSnapshot,
  type PickerContext,
} from "@/server/booking/picker";

/**
 * The three things the time picker can ask the server to do.
 *
 * THESE ARE PUBLIC, UNAUTHENTICATED ENDPOINTS. A Server Action compiles to an
 * HTTP route that anybody can post to, and this one has no session behind it
 * at all — customers book as guests. So every input is parsed with Zod, every
 * id is re-resolved against the business named by the public slug, and the one
 * privileged operation (giving a slot back) is gated on the appointment's own
 * manage token, which only the browser that took the hold has.
 *
 * WHAT ACTUALLY PROTECTS THE SLOT is none of that. It is the `held` row and
 * the exclusion constraint over it: from the millisecond a customer taps a
 * time, the database refuses to let anybody else have it, and no amount of
 * concurrent traffic can produce two holds on one slot. Everything in this
 * file is about turning that guarantee into sentences a person can act on.
 *
 * EVERY OUTCOME CARRIES A FRESH DAY. Success, refusal, race lost — the picker
 * is handed the current truth each time, so it redraws from the server rather
 * than patching its own optimistic guess. There is exactly one place in this
 * flow where the client's idea of the day and the database's can differ, and
 * it is the fifteen seconds between polls.
 */

const requestSchema = z.object({
  slug: z.string().min(1).max(64),
  serviceId: z.uuid(),
  /** A staff id, `any`, or absent when the business has one qualified person. */
  staffId: z.union([z.literal(ANY_STAFF), z.uuid()]).nullable().default(null),
  date: z.string().regex(LOCAL_DATE_PATTERN),
});

const takeSchema = requestSchema.extend({
  /** The instant the customer tapped. Checked against the day's real starts. */
  startsAt: z.iso.datetime(),
});

export type PickerRequest = z.infer<typeof requestSchema>;

/** The generic failure. Never leaks an exception message to a customer. */
const brokeMessage =
  "We could not reach the calendar just now. Try that again in a moment.";

/**
 * Load the day and, if the cookie points at a live one, the customer's hold.
 *
 * Shared by all three actions so a refusal shows the same day a success would
 * have, and so the hold on screen is always one that still exists in Postgres.
 */
async function snapshotFor(context: PickerContext, date: string) {
  const held = await readHoldFor(context.slug);

  const loaded = await loadPickerSnapshot(
    context,
    date,
    held
      ? { appointmentId: held.hold.appointmentId, startsAt: held.hold.startsAt }
      : null,
    held?.hold ?? null,
  );

  return loaded ? { ...loaded, held } : null;
}

/**
 * The appointment this browser's cookie names, live or lapsed.
 *
 * DELIBERATELY NOT `readHoldFor`, which reports only holds that are still
 * within their deadline because that is what a countdown may be drawn against.
 * Releasing is the other question: a row whose deadline has passed but which
 * nothing has swept yet is still occupying its slot as far as the exclusion
 * constraint is concerned, and giving it back is exactly what the customer
 * just asked for.
 */
async function ownedAppointment(slug: string) {
  return readHoldCookie(slug);
}

/* ===========================================================================
   Take a slot
   =========================================================================== */

/**
 * Reserve a time — for real.
 *
 * The write is not "mark it pending in the UI and hope". It inserts a `held`
 * appointment with a database-computed deadline, and the exclusion constraint
 * makes that row block every other booking for as long as it lives. If the
 * customer already held a different time, the release and the new hold happen
 * in ONE transaction (`moveHold`), so they are never holding two slots and
 * never — not even for a millisecond between two requests — holding none.
 */
export async function takeSlot(
  input: z.input<typeof takeSchema>,
): Promise<TakeSlotResult> {
  const parsed = takeSchema.safeParse(input);

  if (!parsed.success) {
    return { ok: false, reason: "error", message: brokeMessage };
  }

  const request = parsed.data;
  const context = await resolvePicker(request);

  if (!context) {
    return { ok: false, reason: "error", message: brokeMessage };
  }

  const before = await snapshotFor(context, request.date);

  if (!before) {
    return { ok: false, reason: "error", message: brokeMessage };
  }

  /**
   * IS THIS TIME EVEN ON OFFER?
   *
   * Checked against `starts` — every start the POLICY allows today, which the
   * server computed and never sent to the browser. The exclusion constraint
   * would stop a double booking regardless, but it has no opinion about
   * whether three in the morning is inside opening hours or whether the
   * two-hour lead time has passed. That is this check, and it is why a
   * hand-rolled request cannot book a time the picker never drew.
   */
  if (!before.day.starts.has(request.startsAt)) {
    return {
      ok: false,
      reason: "gone",
      message: "That time was just booked. Here are the nearest openings.",
      snapshot: before.snapshot,
      nearest: nearestOffers(before.snapshot.day.offers, request.startsAt),
    };
  }

  /**
   * WHO PERFORMS IT. For a named staff member this is that person; for
   * "anyone available" it is the first person free at that instant, in the
   * business's own display order. The engine already worked out who is free —
   * no second query, and no chance of assigning somebody who is not.
   */
  const freeAt = before.day.staffAt.get(request.startsAt) ?? [];
  const staffId =
    context.staffId === ANY_STAFF ? freeAt[0] : context.staffId;

  if (!staffId || !freeAt.includes(staffId)) {
    return {
      ok: false,
      reason: "gone",
      message: "Nobody is free at that time any more. Here are the nearest openings.",
      snapshot: before.snapshot,
      nearest: nearestOffers(before.snapshot.day.offers, request.startsAt),
    };
  }

  const holdInput = {
    businessId: context.businessId,
    staffId,
    serviceId: context.service.id,
    startsAt: request.startsAt,
    // Anonymous on purpose: the slot is reserved before the customer has typed
    // a single character. See the CHECK constraint in migration 0005.
    customerId: null,
  };

  try {
    /* The COOKIE, not the live hold: if the previous one lapsed while the
       customer was deciding, its row is still sitting there and the move
       should clear it rather than leave it for the janitor. `moveHold` treats
       a missing or lapsed previous hold as nothing to release, so this is safe
       either way. */
    const previous = await ownedAppointment(context.slug);

    const held = previous
      ? await moveHold(db, holdInput, {
          appointmentId: previous.appointmentId,
          manageToken: previous.manageToken,
        })
      : await createHold(db, holdInput);

    await writeHoldCookie({
      appointmentId: held.appointment.id,
      manageToken: held.manageToken,
      slug: context.slug,
    });

    const snapshot = await loadPickerSnapshot(
      context,
      request.date,
      { appointmentId: held.appointment.id, startsAt: request.startsAt },
      toSnapshot(
        held.appointment.id,
        held.appointment.startsAt,
        held.appointment.endsAt,
        // Written by `now() + interval` in Postgres, so this is the database's
        // deadline and not an approximation the application computed.
        held.appointment.holdExpiresAt ?? new Date(),
        held.appointment.createdAt,
      ),
    );

    if (!snapshot) {
      return { ok: false, reason: "error", message: brokeMessage };
    }

    return { ok: true, snapshot: snapshot.snapshot };
  } catch (error) {
    /**
     * THE RACE, LOST — and the reason this whole design is worth it.
     *
     * SQLSTATE 23P01 means another transaction inserted an overlapping row
     * first. It is not an exception to apologise for; it is the database
     * doing exactly what it was asked to do, and the only correct response is
     * to redraw the day and offer the nearest times. The customer never sees
     * the word "constraint", and never sees a slot they were told they had.
     */
    if (error instanceof SlotTakenError) {
      const after = await snapshotFor(context, request.date);

      if (!after) {
        return { ok: false, reason: "error", message: brokeMessage };
      }

      return {
        ok: false,
        reason: "taken",
        message: "That time was just booked. Here are the nearest openings.",
        snapshot: after.snapshot,
        nearest: nearestOffers(after.snapshot.day.offers, request.startsAt),
      };
    }

    if (error instanceof ServiceNotFoundError) {
      return {
        ok: false,
        reason: "gone",
        message: "That service is not being offered any more.",
        snapshot: before.snapshot,
        nearest: [],
      };
    }

    throw error;
  }
}

/* ===========================================================================
   Give a slot back
   =========================================================================== */

/**
 * Release the hold this browser is carrying.
 *
 * Called when the customer deselects, when they leave the page, and when the
 * countdown reaches zero. NONE OF THOSE ARE LOAD-BEARING: every one is a
 * courtesy that returns the slot to the pool sooner than it would otherwise
 * come back. The deadline on the row is what actually ends a hold, and it ends
 * it whether or not this call was ever made — see `reclaimExpiredHolds` and
 * the delete-expired step inside every booking transaction.
 *
 * Which is why a missing or already-swept hold is a SUCCESS here. "The slot is
 * not yours any more" is precisely what the caller asked for.
 */
export async function releaseSlot(
  input: z.input<typeof requestSchema>,
): Promise<ReleaseSlotResult> {
  const parsed = requestSchema.safeParse(input);

  if (!parsed.success) {
    return { ok: false, reason: "error", message: brokeMessage };
  }

  const request = parsed.data;
  const context = await resolvePicker(request);

  if (!context) {
    return { ok: false, reason: "error", message: brokeMessage };
  }

  const owned = await ownedAppointment(context.slug);

  if (owned) {
    await releaseHoldByToken(db, owned.appointmentId, owned.manageToken);
  }

  await clearHoldCookie();

  const snapshot = await loadPickerSnapshot(context, request.date, null, null);

  if (!snapshot) {
    return { ok: false, reason: "error", message: brokeMessage };
  }

  return { ok: true, snapshot: snapshot.snapshot };
}

/* ===========================================================================
   Poll
   =========================================================================== */

/**
 * What does the day look like right now?
 *
 * Read-only, and the only thing the fifteen-second poll calls. It reports the
 * hold as well as the day, which is how an expiry the browser has not noticed
 * yet gets corrected: the row is gone, the snapshot says `hold: null`, and the
 * picker returns the customer to the day with their details intact.
 */
export async function refreshDay(
  input: z.input<typeof requestSchema>,
): Promise<RefreshDayResult> {
  const parsed = requestSchema.safeParse(input);

  if (!parsed.success) {
    return { ok: false, reason: "error", message: brokeMessage };
  }

  const request = parsed.data;
  const context = await resolvePicker(request);

  if (!context) {
    return { ok: false, reason: "error", message: brokeMessage };
  }

  const snapshot = await snapshotFor(context, request.date);

  if (!snapshot) {
    return { ok: false, reason: "error", message: brokeMessage };
  }

  return { ok: true, snapshot: snapshot.snapshot };
}
