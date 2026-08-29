import { defineConfig, devices } from "@playwright/test";

import { e2eDatabaseUrl } from "./e2e/fixtures/database";

/**
 * The browser suite: one path, the one where money changes hands.
 *
 * ═══ IT RUNS AGAINST A PRODUCTION BUILD ═══
 *
 * `next dev` compiles on demand, so the first navigation to a route can take
 * seconds and a timeout becomes a coin toss rather than a signal. `next build`
 * then `next start` is what the deployment runs, it is what a Server Action
 * behaves like when it is not being recompiled, and it makes the suite's
 * timings mean something.
 *
 * ═══ THE MAILER IS STUBBED BY CONFIGURATION, NOT BY A MOCK ═══
 *
 * `RESEND_API_KEY` is blanked below, and the mailer's own console fallback
 * takes over — the same fallback a developer runs on all day. No test double,
 * no module interception, and the outbox rows the booking writes are real
 * rows written by the real code. What is skipped is one HTTP call to Resend,
 * which is exactly the part that is not ours.
 *
 * ═══ THE DATABASE IS NEVER THE DEVELOPMENT ONE ═══
 *
 * The fixture deletes its business by slug and rebuilds it, so the server
 * under test is pointed at `E2E_DATABASE_URL` / `TEST_DATABASE_URL`. In CI
 * both are the same throwaway container.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * Whether the caller has already built the application.
 *
 * Locally, nobody wants to remember to build before testing, so the suite does
 * it. In CI the build is its own step, for two reasons: a cold Next build on a
 * two-core runner is most of the job's time and it should be visible as its
 * own line rather than hidden inside "starting the web server", and a build
 * that fails should say so instead of surfacing as a server that never
 * answered.
 */
const SKIP_BUILD = Boolean(process.env.E2E_SKIP_BUILD);

/** Resolved once, and shared with the server the suite starts. */
const DATABASE_URL = e2eDatabaseUrl();

export default defineConfig({
  testDir: "./e2e",
  /* The specs share one fixture business and book into the same day, so they
     must not race each other for a slot. One worker, in order. */
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  globalSetup: "./e2e/global-setup.ts",

  timeout: 90_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: BASE_URL,
    /* Kept only for a failure. A trace per run is megabytes of artefact for a
       suite that is green almost every time. */
    trace: "retain-on-failure",
    video: "off",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: SKIP_BUILD
      ? `npx next start --port ${PORT}`
      : `npm run build && npx next start --port ${PORT}`,
    /**
     * A PORT, NOT A URL, and the difference cost a CI run.
     *
     * Playwright's URL probe waits for a response under 400, and the landing
     * page it would have hit reads the database. Against a container that is
     * ten seconds old and not yet migrated that is a 500, so the server was up,
     * answering, and reported as one that never started. Waiting on the port
     * asks the only question this check should ask.
     */
    port: PORT,
    /**
     * A COLD NEXT BUILD ON A TWO-CORE RUNNER, and the number is set by that
     * rather than by what a developer's laptop does.
     *
     * Five minutes was not enough in CI and the suite reported a webServer
     * timeout — which reads as "the application would not start" and is
     * nothing of the kind. A build that fails still fails fast, because `&&`
     * short-circuits and Playwright reports a process that exited rather than
     * one that never answered. So the only thing a generous number costs is
     * patience on a run that was going to be slow anyway; the job's own
     * timeout is the real bound.
     */
    timeout: SKIP_BUILD ? 120_000 : 900_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      DATABASE_URL,
      NODE_ENV: "production",
      /* The origin everything must agree on: Better Auth's callbacks, the
         links in email, and Stripe's redirect back. */
      BETTER_AUTH_URL: BASE_URL,
      NEXT_PUBLIC_APP_URL: BASE_URL,
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ??
        "e2e-secret-not-used-for-anything-real-0123456789",
      /* Blank: the mailer prints to the console instead of calling Resend. */
      RESEND_API_KEY: "",
      /* Blank: nothing is scheduled, so the daily sweep owns every message.
         The E2E never waits for one. */
      QSTASH_TOKEN: "",
      /**
       * PASSED THROUGH WHEN PRESENT, absent otherwise — and the suite adapts
       * rather than failing. With a key the deposit path goes to Stripe and
       * the card spec runs; without one the deposit is skipped and only the
       * free path runs. See e2e/stripe-card.spec.ts.
       */
      ...(process.env.STRIPE_SECRET_KEY
        ? { STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY }
        : {}),
      ...(process.env.STRIPE_WEBHOOK_SECRET
        ? { STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET }
        : {}),
      ...(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
        ? {
            NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:
              process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
          }
        : {}),
    },
  },
});
