import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const resolve = (path: string) =>
  fileURLToPath(new URL(path, import.meta.url));

/** Files that need a real Postgres. See test/README.md. */
export const INTEGRATION_GLOB = "test/**/*.integration.test.ts";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve("./src"),
      /**
       * `server-only` throws by design when imported outside a React Server
       * Component. Vitest runs in plain Node, so it resolves to a stub — the
       * guard still protects the application build, which is where it matters.
       */
      "server-only": resolve("./test/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    /**
     * The suite is grouped by priority — 1-concurrency, 2-time, 3-payments,
     * 4-invites, and so on — and the glob walks all of it. `e2e/` is
     * deliberately outside `test/` so this never picks up a Playwright spec,
     * which would fail on the first `page` it could not find.
     */
    include: ["test/**/*.test.ts"],
    /**
     * Two clocks, and the difference matters.
     *
     * A unit test here is a few microseconds of arithmetic; 30 seconds is not
     * generosity, it is the allowance an INTEGRATION test needs for a round
     * trip to a hosted Postgres that may have scaled to zero since the last
     * run. The hook allowance is larger again because the first one applies
     * every migration.
     */
    testTimeout: 30_000,
    hookTimeout: 120_000,
    /**
     * The integration suite shares one database. Files must not run
     * concurrently or they would truncate each other's fixtures mid-test.
     */
    fileParallelism: false,
  },
});
