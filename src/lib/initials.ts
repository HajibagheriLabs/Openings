/**
 * Initials, derived from a name.
 *
 * These end up on booked ribbon segments, where hue carries no meaning and the
 * only thing distinguishing one person's column from another's is two
 * characters of ink. That is why they are a real column on `staff` and not
 * computed at render time: the owner has to be able to fix "Anna Andersson"
 * and "Anders Ahlberg" both collapsing to "AA", and a derived value cannot be
 * fixed.
 *
 * This is the DEFAULT. Onboarding and the staff form both start here and both
 * let the owner overwrite it.
 */

/** "Rosa Delgado" becomes "RD". First and last initial, never the middle. */
export function initialsFrom(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return "?";
  }

  const first = parts[0].charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";

  return (first + last).toUpperCase() || "?";
}
