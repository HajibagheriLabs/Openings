import "server-only";

import { Temporal } from "temporal-polyfill";

/**
 * The one and only date/time implementation in this project.
 *
 * WHY TEMPORAL, AND WHY THE POLYFILL
 * ----------------------------------
 * Temporal is not a global in the Node version we target (checked on Node
 * 24.18 / V8 13.6: `typeof Temporal === "undefined"`, with and without
 * --harmony), so it has to be brought in. `temporal-polyfill` gives us the
 * final Stage 3 API; the ISO-only class API we import here is ~52 KB minified
 * and never reaches the browser, because everything that touches it is
 * server-only (see the import above).
 *
 * It is preferred over Luxon for two reasons that are specific to this
 * product:
 *
 *   1. DST ambiguity is explicit rather than guessed. `toZonedDateTime` takes
 *      a `disambiguation` option, so a wall-clock time that does not exist
 *      (spring forward) or happens twice (fall back) can be REJECTED and
 *      handled, instead of being silently shifted or silently resolved to the
 *      first of the two offsets. Openings has to be correct on exactly those
 *      two days, so being able to detect them is the whole point.
 *
 *   2. The type system matches the domain model. `availability_rules` stores
 *      recurring weekly hours as plain local times, which is a
 *      `Temporal.PlainTime` — a type that genuinely cannot carry an offset.
 *      Appointments store instants, which are `Temporal.Instant`. The compiler
 *      then stops us from mixing the two, which is the bug class this schema
 *      is designed to avoid.
 *
 * When Node ships Temporal natively, delete the import above and re-export the
 * global. Nothing else in the codebase changes, because nothing else imports
 * `temporal-polyfill` directly.
 *
 * THE RULES THAT GO WITH IT
 * -------------------------
 * - All scheduling arithmetic happens here, on the server, in the business
 *   timezone. `import "server-only"` makes importing this from a client
 *   component a build error rather than a runtime surprise.
 * - The API hands the client ISO instants plus the business timezone string.
 *   The client formats them with `Intl.DateTimeFormat` and does no arithmetic.
 * - Never add fixed hour offsets. Never do calendar math on raw milliseconds.
 */
export { Temporal };

/** An IANA timezone identifier, e.g. "Europe/Berlin". Never an offset. */
export type TimeZoneId = string;
