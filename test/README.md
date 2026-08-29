# Tests

**Coverage is not the goal.** This suite is ordered by what it would cost to get wrong, and the
directory names are the order. A test earns its place by protecting something that would be
expensive, silent, or embarrassing to break — not by touching a line nobody has touched yet.

Everything here is deterministic. Clocks are injected, never read; randomness is seeded; the
integration files run against a real Postgres with `btree_gist`, because the guarantees they check
are enforced by the database and a mock would only be checking itself.

| Directory | What it protects | Why it is where it is |
| --- | --- | --- |
| `1-concurrency/` | The exclusion constraint, and holds | Two customers, one chair. Silent, unrecoverable, and the reason the project exists. |
| `2-time/` | DST, timezones, availability | Wrong twice a year, in one timezone, for one business. Nobody reports it; they just stop trusting the calendar. |
| `3-payments/` | Stripe webhooks and deposits | Money. Doubles, drops and unrefunded losses. |
| `4-invites/` | The `.ics` lifecycle | A stale invite puts the wrong time in somebody's calendar and they arrive on the wrong day. |
| `5-policy/` | Server-side policy, manage tokens | A public HTTP endpoint is not a form. Every rule the client shows is re-checked here. |
| `6-delivery/` | The outbox | A confirmed appointment nobody was told about is worse than a failed booking. |
| `support/` | Pure helpers | URL parsing, flow arithmetic, ribbon scale. Cheap, fast, and they catch the silly ones. |
| `helpers/`, `stubs/` | Fixtures and the `server-only` stand-in | Not tests. |

`e2e/` at the repository root is Playwright: the one path where money changes hands, driven through a
real browser.

## Running them

```bash
npm run test:unit         # no database, ~9s
npm run test:integration   # needs TEST_DATABASE_URL
npm test                   # both
npm run test:e2e           # Playwright, needs a database
```

`*.integration.test.ts` files connect to `TEST_DATABASE_URL` and **truncate tables between cases**,
so that variable is required and must differ from `DATABASE_URL`. With Neon the cheapest way to get
one is a branch.

## What is deliberately not tested

- **React component rendering.** The components are thin: they format instants the server resolved
  and draw geometry the server computed. The arithmetic behind them is tested directly, and snapshot
  tests of markup would fail on every design change while catching nothing.
- **Better Auth's own flows.** Sign-up, verification and password reset are a dependency's behaviour.
  What is tested is the boundary this project owns — that owner routes refuse a caller without a
  session, which the E2E and the policy suite cover.
- **Stripe's hosted Checkout page.** It is not ours, it changes, and driving it in CI needs
  credentials CI should not hold. The E2E takes the card path when Stripe keys are present and the
  free-booking path when they are not; the webhook — the part that actually confirms a booking — is
  covered exhaustively by `3-payments/`.
- **Email deliverability.** Whether Resend gets a message into an inbox is Resend's problem. What is
  tested is that the right rows are written, that the worker drains and retries them, and that each
  template says the right things.
- **The seed script's exact output.** It is scenery. Its determinism is a property of the generator,
  and the rules it must not break — the exclusion constraint, the demo guards — are tested where
  they live.
