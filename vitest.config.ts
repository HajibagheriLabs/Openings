import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const resolve = (path: string) =>
  fileURLToPath(new URL(path, import.meta.url));

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
    include: ["test/**/*.test.ts"],
    // Real network round-trips to Postgres, plus a migration run on startup.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    /**
     * The integration suite shares one database. Files must not run
     * concurrently or they would truncate each other's fixtures mid-test.
     */
    fileParallelism: false,
  },
});
