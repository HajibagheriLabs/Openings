/**
 * How much of the day a service actually costs.
 *
 * The customer books 45 minutes. The calendar loses 55, because the service
 * reserves ten minutes afterwards to reset the room. That gap between what is
 * sold and what is spent is the single most misunderstood thing about buffers,
 * and this module exists so the service form can state it in a sentence
 * instead of leaving the owner to find out in three weeks of double-length
 * days.
 *
 * Deliberately free of Temporal and of `server-only`: this is arithmetic on
 * minutes, it runs in the form as the owner types, and it must not drag a
 * timezone library into the client bundle. The REAL blocking range — the one
 * the exclusion constraint arbitrates — is built in ./slot.ts from the same
 * three numbers.
 */

export interface BufferedTiming {
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
}

/** Total minutes removed from the day, buffers included. */
export function blockedMinutes(timing: BufferedTiming): number {
  return timing.bufferBeforeMin + timing.durationMin + timing.bufferAfterMin;
}

export interface BlockedTimePart {
  kind: "before" | "service" | "after";
  minutes: number;
  /** "10 min setup", "45 min appointment". */
  label: string;
}

/**
 * The parts of the strip, in the order they occur in time. Zero-length buffers
 * are omitted — an empty segment is not a fact worth drawing.
 */
export function blockedTimeParts(timing: BufferedTiming): BlockedTimePart[] {
  const parts: BlockedTimePart[] = [];

  if (timing.bufferBeforeMin > 0) {
    parts.push({
      kind: "before",
      minutes: timing.bufferBeforeMin,
      label: `${timing.bufferBeforeMin} min setup`,
    });
  }

  parts.push({
    kind: "service",
    minutes: timing.durationMin,
    label: `${timing.durationMin} min appointment`,
  });

  if (timing.bufferAfterMin > 0) {
    parts.push({
      kind: "after",
      minutes: timing.bufferAfterMin,
      label: `${timing.bufferAfterMin} min cleanup`,
    });
  }

  return parts;
}

/**
 * The sentence: "45 min appointment + 10 min cleanup = 55 min of the day".
 *
 * With no buffers there is no sum to show, so it says the plain thing instead
 * of writing "45 = 45".
 */
export function blockedTimeSentence(timing: BufferedTiming): string {
  const parts = blockedTimeParts(timing);
  const total = blockedMinutes(timing);

  if (parts.length === 1) {
    return `${timing.durationMin} min appointment, and nothing reserved around it.`;
  }

  return `${parts.map((part) => part.label).join(" + ")} = ${total} min of the day`;
}
