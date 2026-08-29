/**
 * What the Ribbon is handed.
 *
 * Every field here is computed on the SERVER. The Ribbon performs no date
 * arithmetic and knows nothing about availability rules, holds, buffers or
 * booking policy — it is given a list of spans that already exist and draws
 * them to scale. Keeping it this dumb is what lets the customer picker and the
 * admin agenda share it without either one's logic leaking into the other.
 */

/**
 * How a span of time looks, and what that look means.
 *
 * THE GOVERNING RULE: these are distinguished by FILL, PATTERN and VALUE —
 * never by hue. There is no green-available / red-booked grid here, because it
 * fails colourblind users and it spends the accent, which belongs to open time
 * and nothing else. Every state also carries an aria-label, because a
 * screen reader cannot see a hatch pattern either.
 */
export type SegmentState =
  /** Bookable. Accent wash with a 1px accent border. The only hue on the ribbon. */
  | "open"
  /** Held by this visitor, right now. Solid accent, plus the depleting hold bar. */
  | "selected"
  /** Held by somebody else. Sunk surface under 45° hairline hatching. Inert. */
  | "held"
  /** Taken. Sunk and INSET — carved into the day, never raised. Shows initials. */
  | "booked"
  /** Closed, on holiday, blocked out. Sunk under denser hatching, with a label. */
  | "blocked"
  /** Gone. A quiet inert block at reduced opacity. */
  | "past";

export interface RibbonSegment {
  id: string;
  state: SegmentState;

  /**
   * Where the segment sits, in MINUTES SINCE LOCAL MIDNIGHT in the business's
   * timezone, and how many minutes it lasts. Both resolved on the server.
   *
   * This is the geometry, and it is deliberately separate from the instants
   * below: the Ribbon multiplies these by the scale and never converts
   * anything.
   */
  startMinute: number;
  durationMin: number;

  /**
   * The same span as real instants, for LABELS ONLY.
   *
   * Formatting an ISO instant into a given timezone with Intl.DateTimeFormat
   * is not arithmetic, and it is exactly what the client is supposed to do.
   * Deriving one of these from the other, in either direction, is not.
   *
   * OPTIONAL, AND THE ABSENCE IS MEANINGFUL. A concrete day — an agenda, a
   * customer's picker — always has instants and always passes them. A
   * RECURRING WEEKLY PATTERN does not: "Monday, 09:00 to 17:00" is a fact
   * about the clock on the wall that means a different instant every week and
   * two different instants on the two days DST moves. Manufacturing one so
   * this field could stay required would be inventing a fact, so the hours
   * preview omits them and the segment labels itself from `startMinute` and
   * `durationMin` instead — which is not arithmetic either, because 540
   * minutes past midnight IS nine o'clock, everywhere, always.
   */
  startsAt?: string;
  endsAt?: string;

  /**
   * Shown inside the segment when there is room, and always in the
   * aria-label. The customer's initials on a booked segment, "Closed" on a
   * blocked one, the service name on an open one.
   */
  label?: string;

  /**
   * Dims to 45% and removes interaction, on top of whatever `state` says.
   *
   * Distinct from `state: "past"`. A customer's picker shows a lapsed slot as
   * a plain past block; the admin's agenda shows this morning's appointment
   * still BOOKED, with its initials, only quieter. Same visual treatment, two
   * different facts.
   */
  isPast?: boolean;

  /**
   * Remaining hold, 0–1, drawn as a bar depleting along the top edge of a
   * `selected` segment. The Ribbon renders the fraction it is given; the
   * countdown that changes it lives with the hold, not here.
   */
  holdRemaining?: number;

  /** Blocks interaction without implying the slot is gone. */
  disabled?: boolean;

  /**
   * Whether this span can be pressed, overriding the default.
   *
   * THE DEFAULT IS "ONLY OPEN TIME", because on the customer's picker only open
   * time is an offer and everything else is a fact. The owner's agenda is the
   * other way round: a booked segment is the thing they came to press — it
   * opens the detail sheet — and so is one from this morning, because "mark as
   * a no-show" is a decision made after the appointment did not happen.
   *
   * Set explicitly rather than inferred from the presence of a handler, so a
   * surface can offer some of its segments and not others; `isPast` still dims
   * the segment to 45% either way, since a past appointment is quieter than a
   * live one without being unreachable.
   */
  selectable?: boolean;

  /**
   * This span JUST changed under the visitor's eyes — somebody else booked it
   * while they were looking at it.
   *
   * The hatch fades in over 240ms instead of appearing, which is the one
   * animation the ribbon is allowed and the only one in the product that
   * carries information: a slot that snaps from open to hatched looks like a
   * rendering glitch, while a slot that fades looks like what it is, which is
   * something that just happened. Off by default, so the admin agenda and the
   * first paint of a picker stay completely still.
   */
  justTaken?: boolean;
}

/**
 * A segment on a CONCRETE DAY, where the instants are guaranteed.
 *
 * Anything a customer can actually book is one of these: you cannot hold, pay
 * for or put in a calendar a recurring pattern, only a real moment. Surfaces
 * that go on to use `startsAt` — the booking summary, the confirmation, the
 * .ics — narrow to this type first rather than reaching for a non-null
 * assertion, so "this span is a real instant" stays something the compiler
 * checks instead of something a comment claims.
 */
export type DatedRibbonSegment = RibbonSegment & {
  startsAt: string;
  endsAt: string;
};

/** True when a segment sits on a real day rather than describing a pattern. */
export function isDatedSegment(
  segment: RibbonSegment,
): segment is DatedRibbonSegment {
  return typeof segment.startsAt === "string" &&
    typeof segment.endsAt === "string";
}

export interface RibbonColumn {
  id: string;
  /** Column heading — a staff member's name, or the day in a single-column picker. */
  label: string;
  /** Second line under the heading. Initials, a role, anything short. */
  sublabel?: string;
  segments: RibbonSegment[];
}
