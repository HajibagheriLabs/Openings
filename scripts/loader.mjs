import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

/**
 * Lets a plain `node` script import the application's own modules.
 *
 * ═══ WHY THIS EXISTS AT ALL ═══
 *
 * The seed script has to build appointments EXACTLY the way the product does —
 * the same blocking range with the same buffers, the same manage-token
 * derivation, the same Postgres range literal. Reimplementing any of that in a
 * script is how a demo ends up showing data the real code could not have
 * produced, and how a subtle disagreement about buffers goes unnoticed for a
 * month.
 *
 * So the script imports `@/lib/scheduling/slot` and friends. Two things stand
 * in the way outside Next, and this file removes both:
 *
 *   1. THE `@/` ALIAS is a TypeScript path mapping. `tsc` understands it and
 *      Node does not, so it is rewritten here to a real path under src/.
 *
 *   2. `server-only` THROWS when Node loads it. That guard is doing its job —
 *      it exists to make importing a server module from a Client Component a
 *      build error — but a seed script is about as server-side as code gets,
 *      and there is no bundler here to swap in the empty module the package
 *      ships for exactly this purpose. It is pointed at that empty module.
 *
 * Node handles the TypeScript itself, so nothing here compiles anything — only
 * resolution needs help. The `db:seed` script passes
 * `--experimental-transform-types` rather than relying on the default
 * strip-only mode, because several modules in src/ use CONSTRUCTOR PARAMETER
 * PROPERTIES (`constructor(readonly serviceId: string)`), which strip-only
 * cannot represent: erasing the annotation would erase the assignment with it,
 * so Node refuses rather than silently producing a class whose fields are
 * never set.
 *
 * Used by `npm run db:seed`. It is not part of the application build and
 * nothing the server serves ever loads it.
 */

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

/**
 * The extensions a specifier may be pointing at, in resolution order.
 *
 * TypeScript lets a module import `./schema` and means `./schema.ts`. Node
 * requires the extension, so both the aliased imports and the ORDINARY
 * RELATIVE ONES inside src/ need the same probing — the first failure here was
 * `src/db/client.ts` importing `./schema`, which nothing about the `@/` alias
 * would have fixed.
 */
const CANDIDATES = ["", ".ts", ".tsx", ".js", "/index.ts", "/index.tsx"];

/** The first candidate path that exists, as a file URL, or null. */
function probe(base) {
  for (const suffix of CANDIDATES) {
    const candidate = `${base}${suffix}`;

    if (existsSync(candidate) && !candidate.endsWith("/")) {
      return pathToFileURL(candidate).href;
    }
  }

  return null;
}

function resolveAlias(specifier) {
  return probe(join(SRC, specifier.slice("@/".length)));
}

function resolveRelative(specifier, parentURL) {
  if (!parentURL?.startsWith("file:")) {
    return null;
  }

  return probe(
    resolvePath(dirname(fileURLToPath(parentURL)), specifier),
  );
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      /* The package ships an empty module for the `react-server` condition.
         Pointing at it directly is the same substitution a bundler makes. */
      return {
        url: pathToFileURL(join(ROOT, "node_modules", "server-only", "empty.js"))
          .href,
        shortCircuit: true,
      };
    }

    if (specifier.startsWith("@/")) {
      const url = resolveAlias(specifier);

      if (url) {
        return { url, shortCircuit: true };
      }
    }

    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      const url = resolveRelative(specifier, context.parentURL);

      if (url) {
        return { url, shortCircuit: true };
      }
    }

    return nextResolve(specifier, context);
  },
});
