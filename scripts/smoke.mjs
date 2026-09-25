import { randomBytes } from "node:crypto";

/**
 * The part of the live smoke test a script can prove.
 *
 *   npm run smoke -- https://your-project.vercel.app
 *
 * ═══ WHAT THIS IS, AND WHAT IT IS NOT ═══
 *
 * It is the checks that are mechanical and easy to get wrong by eye: that the
 * security headers are really on the response, that both demo businesses
 * render, that every endpoint a stranger can reach refuses a stranger, and
 * that the configuration the deployment needs is actually present — a Stripe
 * webhook with no secret answers differently from one with a wrong signature,
 * and a cron with no secret answers differently from one with a wrong bearer.
 *
 * It is NOT the smoke test. Paying with a card, receiving the email, adding
 * the invite to a real calendar and watching it move, seeing the agenda update
 * in a second window, trying it on a phone — those need a person, and
 * DEPLOY.md lists them in order. Run this first so the person is not the one
 * discovering a missing header.
 *
 * It sends nothing that changes state: every request is a read, or a write
 * the server is expected to refuse.
 */

const DEMO_BUSINESSES = [
  { slug: "rosas-hair-studio", name: "Hair Studio", zone: "Europe/Lisbon" },
  { slug: "northside-family-clinic", name: "Northside Family Clinic", zone: "America/Chicago" },
];

const origin = process.argv[2]?.replace(/\/+$/, "");

if (!origin || !/^https?:\/\//.test(origin)) {
  console.error("\n  Usage: npm run smoke -- https://your-project.vercel.app\n");
  process.exit(1);
}

const secure = origin.startsWith("https://");
const results = [];

console.log(`\n  Smoke-testing ${origin}\n`);

/* ---- The front page, and the headers on it ------------------------------ */

await check("front page answers 200", async () => {
  const response = await get("/");

  expectStatus(response, 200);

  const headers = response.headers;
  const csp = headers.get("content-security-policy") ?? "";

  expect(csp.includes("https://js.stripe.com"), "CSP allows js.stripe.com");
  expect(csp.includes("https://checkout.stripe.com"), "CSP allows checkout.stripe.com");
  expect(csp.includes("frame-ancestors 'none'"), "CSP sets frame-ancestors 'none'");
  expect(headers.get("x-content-type-options") === "nosniff", "x-content-type-options: nosniff");
  expect(Boolean(headers.get("referrer-policy")), "referrer-policy is set");
  expect(Boolean(headers.get("permissions-policy")), "permissions-policy is set");

  if (secure) {
    expect(
      /max-age=\d+/.test(headers.get("strict-transport-security") ?? ""),
      "strict-transport-security is set",
    );
  }
});

/* ---- Both demo businesses, each in its own timezone --------------------- */

for (const business of DEMO_BUSINESSES) {
  await check(`${business.slug} renders`, async () => {
    const response = await get(`/book/${business.slug}`);

    expectStatus(response, 200);

    const html = await response.text();

    expect(html.includes(business.name), `page names "${business.name}"`);
    expect(
      html.includes(business.zone),
      `page carries its own timezone, ${business.zone} — not the server's`,
    );
  });
}

/* ---- A manage link nobody was sent -------------------------------------- */

await check("an invented manage link says nothing", async () => {
  const token = randomBytes(32).toString("base64url");
  const response = await get(`/manage/${token}`);
  const html = await response.text();

  expect(response.status < 500, `answers without a server error (got ${response.status})`);

  for (const business of DEMO_BUSINESSES) {
    expect(!html.includes(business.name), `does not mention ${business.name}`);
  }

  expect(
    (response.headers.get("x-robots-tag") ?? "").includes("noindex"),
    "is marked noindex",
  );
});

/* ---- Every endpoint a stranger can reach refuses a stranger ------------- */

await check("daily cron refuses a caller without the secret", async () => {
  const response = await get("/api/cron/daily");

  expect(
    response.status !== 503,
    "CRON_SECRET is set (503 means the route has no secret to check against)",
  );
  expectStatus(response, 401);
});

await check("Stripe webhook refuses an unsigned event", async () => {
  const response = await post("/api/webhooks/stripe", "{}");

  expect(
    response.status !== 500,
    "STRIPE_WEBHOOK_SECRET is set (500 means the route is not configured)",
  );
  expectStatus(response, 400);
});

await check("reminder worker refuses an unsigned delivery", async () => {
  const response = await post(
    "/api/notifications/deliver",
    JSON.stringify({ notificationId: "00000000-0000-0000-0000-000000000000" }),
  );

  expectStatus(response, 401);
});

await check("owner agenda stream refuses a stranger", async () => {
  const response = await get("/api/admin/agenda/stream");

  expectStatus(response, 401);
  await response.body?.cancel();
});

/* ---- Report -------------------------------------------------------------- */

const failed = results.filter((result) => !result.ok);

console.log("");

if (failed.length > 0) {
  console.error(`  ✗ ${failed.length} of ${results.length} checks failed.\n`);
  process.exit(1);
}

console.log(`  All ${results.length} checks passed. Now do the parts that need a person — DEPLOY.md §3.\n`);

/* ---- Helpers ------------------------------------------------------------- */

async function check(name, run) {
  try {
    await run();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.error(`  ✗ ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

function get(path) {
  return fetch(`${origin}${path}`, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
}

function post(path, body) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
}

function expect(condition, what) {
  if (!condition) {
    throw new Error(`expected: ${what}`);
  }
}

function expectStatus(response, status) {
  expect(response.status === status, `HTTP ${status}, got ${response.status}`);
}
