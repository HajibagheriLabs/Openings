export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 48;

/** Lowercase letters, digits, and single inner hyphens. Nothing else. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Slugs that would collide with an application route or read as official.
 * `/book/admin` must never be a real business.
 */
export const RESERVED_SLUGS = new Set([
  "about",
  "admin",
  "api",
  "book",
  "forgot-password",
  "help",
  "new",
  "onboarding",
  "openings",
  "reset-password",
  "settings",
  "sign-in",
  "sign-up",
  "support",
]);

/**
 * Business name to URL slug.
 *
 * The result is what a customer sees: /book/rosas-hair-studio. It is offered
 * to the owner as a suggestion and stays editable, because a business often
 * wants something shorter than its legal name produces.
 *
 * Normalisation is Unicode-aware: "Café Éclair" becomes "cafe-eclair" rather
 * than dropping the accented letters. NFD splits each letter from its accent,
 * and the combining-mark block (U+0300–U+036F) is then removed.
 */
export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // Apostrophes vanish rather than becoming separators: "Rosa's" is
    // one word, and rosa-s-hair-studio reads like a typo.
    .replace(/['\u2018\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
}
