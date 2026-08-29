import { appendFileSync, readFileSync } from "node:fs";

/**
 * Report what the browser suite actually did, and refuse a run that did nothing.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * A Playwright run where every test skipped itself exits 0. So does one where
 * the config matched no files at all — a renamed directory, a bad `testDir`, a
 * `test.skip` guard that turned out to be true everywhere. CI would go green
 * and the badge would be a lie, and nobody looks closely at a green badge.
 *
 * The suite has exactly one job — prove the money path works end to end — so a
 * run that proved nothing is a failure, and this says so.
 *
 * It also writes the counts to the job summary, because "6 seconds" in a step
 * list is not enough to tell a fast suite from an empty one, and the whole
 * point of the guard is that the difference matters.
 */

const REPORT = "playwright-report/results.json";

/** At least the booking journey. The card spec may legitimately skip. */
const MINIMUM_PASSED = 1;

function main() {
  let stats;

  try {
    stats = JSON.parse(readFileSync(REPORT, "utf8")).stats;
  } catch (error) {
    fail(
      `No Playwright report at ${REPORT}. The run did not get far enough to ` +
        `write one.\n${error}`,
    );
    return;
  }

  const line =
    `Playwright: ${stats.expected} passed, ${stats.skipped} skipped, ` +
    `${stats.unexpected} failed, ${stats.flaky} flaky`;

  console.log(line);
  summarise(line);

  if (stats.unexpected > 0) {
    fail(`${stats.unexpected} browser test(s) failed.`);
    return;
  }

  if (stats.expected < MINIMUM_PASSED) {
    fail(
      `Only ${stats.expected} browser test(s) passed. A run where everything ` +
        "skipped is not a green run — the suite exists to prove the money " +
        "path works, and it proved nothing.",
    );
  }
}

/** Add a line to the GitHub job summary, when there is one to add it to. */
function summarise(line) {
  const path = process.env.GITHUB_STEP_SUMMARY;

  if (path) {
    appendFileSync(path, `${line}\n`);
  }
}

function fail(message) {
  console.error(message);
  summarise(message);
  process.exitCode = 1;
}

main();
