# Deploying Openings

Everything needed to take this from a laptop to a public URL, in the order it
has to happen, plus the operational procedures that only matter once real
people are using it.

Where something is a known limitation it says so rather than being left out.
The application steps here have been exercised against a running build; the DNS
in §5 depends on your registrar and has to be done once, by you.

---

## 1. Before anything else: the database

Neon, or any Postgres 14+.

**`btree_gist` is not optional.** The no-overlap exclusion constraint is what
makes this application correct, and it cannot be created without the extension.
The first migration creates it; a role without permission to do so will fail
there rather than half-way through.

```bash
npm run db:migrate
```

Use **two** databases, not one. `TEST_DATABASE_URL` must differ from
`DATABASE_URL` — the concurrency suite `TRUNCATE`s tables and refuses to run if
the two match. On Neon, a branch is the cheapest way to get a second one.

---

## 2. Environment

Copy `.env.example` to `.env.local` (locally) or paste the values into the
hosting provider's environment settings. `src/env.ts` validates the whole set
on first read and fails with the complete list of what is wrong, so a
misconfigured deploy dies at startup instead of at the first booking.

### Required in production

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Pooled connection string. |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32`. **Rotating it signs every owner out AND invalidates every manage link already sent** — the links are derived from it. See `src/lib/notifications/manage-link.ts`. |
| `BETTER_AUTH_URL` | The deployed origin. |
| `NEXT_PUBLIC_APP_URL` | The deployed origin. Used for email links and Stripe redirects. |
| `CRON_SECRET` | The daily sweep refuses to run without it when `NODE_ENV=production`. An open sweep is an open "send every queued email now" button. |

### Optional, and what each one degrades to

| Variable | Absent means |
| --- | --- |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | No card step. A service with a deposit keeps its hold and tells the customer to arrange payment with the business; a service without one books normally. |
| `RESEND_API_KEY` | **Mail is not delivered.** In development the message is printed in full. In production only the envelope is logged — see §6. |
| `QSTASH_TOKEN` + the two signing keys | No per-booking reminders. Anything due is sent inline on confirmation; the rest waits for the daily sweep, so a reminder can be up to a day late but is never lost. |

The app **refuses a live Stripe key.** `assertTestMode` throws the first time a
Stripe client is constructed — so the failure lands on the first request that
would have touched Stripe, not silently on a customer's card. This is test mode
only and there is no configuration that turns that off.

---

## 3. Vercel

- Fluid Compute **on**.
- `vercel.json` already declares the one daily cron (`/api/cron/daily` at
  03:00). Vercel sends `Authorization: Bearer $CRON_SECRET` automatically, so
  nothing has to be configured twice.
- Set every variable from §2 for the Production environment.

Security headers are set in `next.config.ts`, not in `vercel.json`, so they
apply to `next start` and to local development too. A header that only exists
in production is a header nobody tests.

---

## 4. Stripe

1. Create a webhook endpoint at `https://<your-domain>/api/webhooks/stripe`.
2. Subscribe to exactly three events:
   - `checkout.session.completed`
   - `checkout.session.expired`
   - `charge.refunded`
3. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

**The success redirect is not proof of payment.** An appointment becomes
`confirmed` only inside the verified webhook. If you are testing and a booking
stays "confirming", the webhook is not arriving — check the endpoint, not the
application.

### If the Stripe account is shared

A test-mode account belongs to a developer, not to a project, so another app's
events may arrive at this endpoint perfectly signed. Every object this
application creates carries `metadata.app=openings` and the handler ignores
anything without it. `stripe listen` forwards *every* event on the account, so
narrow it locally:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe --events checkout.session.completed,checkout.session.expired,charge.refunded
```

---

## 5. Email deliverability — SPF, DKIM and DMARC

**Transactional mail from an unauthenticated domain goes to spam, and a booking
confirmation in a spam folder is a customer who does not turn up.** This is the
step most likely to be skipped and the one whose failure is least visible.

### Verify the sending domain in Resend

Resend → Domains → Add Domain. It issues three DNS records. Add all three at
the registrar, then wait for Resend to show the domain as **Verified**.

| Record | Type | Why |
| --- | --- | --- |
| `send.<domain>` | MX + TXT (SPF) | Authorises Resend's servers to send as your domain. |
| `resend._domainkey.<domain>` | TXT (DKIM) | The public key that signs each message. Receivers check the signature, so a forged message fails. |
| `_dmarc.<domain>` | TXT (DMARC) | Tells receivers what to do when SPF and DKIM fail, and where to send reports. |

A reasonable DMARC record to start with — monitoring only, so nothing is
rejected while you confirm it is working:

```
_dmarc.<domain>  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@<domain>; fo=1"
```

Once reports show your own mail passing, tighten to `p=quarantine` and then
`p=reject`.

### Then set `EMAIL_FROM`

```
EMAIL_FROM="Rosa's Hair Studio <bookings@yourdomain.com>"
```

It must be **on the verified domain**. The default
`onboarding@resend.dev` works for testing and is rate-limited and shared — it is
not for production.

### Checking it actually works

Send yourself a confirmation and open the raw headers. You want:

```
Authentication-Results: ... spf=pass ... dkim=pass ... dmarc=pass
```

Anything else means the DNS is not right yet, whatever the dashboard says.

### One thing that is not configurable

There is **no unsubscribe link**, deliberately. Every message this application
sends is transactional — a confirmation, a reminder, a cancellation, a password
reset. There is no marketing list to leave, and offering an unsubscribe from
your own appointment confirmation would be worse than not offering one. The
footers say plainly why each message arrived and who to contact; see
`emails/components/booking.tsx`.

---

## 6. What is logged, and what is deliberately not

Server logs are retained by the hosting platform and readable by anyone with
dashboard access, so they are treated as a place secrets must not go.

- **No API key is ever logged.** The QStash client's errors are reduced to
  their message before logging, because an SDK error object can carry the
  request — and the request carries the bearer token.
- **No secret reaches the browser.** The server schema lives in
  `src/env.server.ts` behind `server-only`, so importing it from a Client
  Component is a build error rather than a silent disclosure. Verified by
  scanning the built client chunks for every value in `.env.local`: the only
  matches are the two `NEXT_PUBLIC_*` values, which are public by definition.
- **Without `RESEND_API_KEY`, production logs the envelope only** — recipient
  and subject — and drops the body. Every message this app sends contains a
  live credential in its body: a manage token, a reset link, a verification
  link. In development the full body is printed, which is what lets somebody
  clone the repository and complete a booking with no email provider.
- **Refunds are logged on success as well as failure**, with the appointment
  id, the Stripe refund id and the payment intent, so the money trail is
  readable without opening Stripe.

If mail silently stops in production, look for
`[mailer] NOT SENT — RESEND_API_KEY is not set`.

---

## 7. Reconstructing the money trail

Every payment can be accounted for from two places, with no third ledger to
keep in sync:

1. **The `appointments` row** — `stripe_checkout_session_id`,
   `stripe_payment_intent_id`, `deposit_cents`, `price_cents`, `refunded_cents`
   and `refunded_at`. This is the **durable** half. Given an appointment you can
   find its payment in Stripe; given a Stripe payment you can find the
   appointment, because the session and intent ids are both stored and every
   object also carries `metadata.appointment_id`.
2. **`webhook_events`** — the id and type of every Stripe event processed, with
   when it was processed.

**Be precise about the second one.** `webhook_events` is an *idempotency guard*,
not a ledger, and the daily cron **prunes it after 30 days**
(`forgetOldWebhookEvents`) — the guard only has to outlive Stripe's retry
window, which is about three days. So "which events touched this appointment"
is answerable for a month; after that the appointment row plus Stripe's own
records (which are retained indefinitely) are what reconcile a charge. If you
need event history for longer, raise the `days` argument — the table is small,
one row per event.

There are **three** refund paths, and every one carries a Stripe **idempotency
key** derived from the appointment id and the reason — so a webhook redelivery
or a double-clicked cancellation cannot issue a second refund. See
`refundIdempotencyKey` in `src/lib/payments/checkout.ts`. The three are: the
webhook's "the slot went before the money landed" apology, the customer
cancelling inside the policy window, and the business cancelling from the
agenda. All three log on success as well as on failure.

**Deposits are computed on the server and only on the server.** The amount
charged comes off the appointment row, snapshotted when the hold was written.
Nothing in any request body can influence it, so a business changing its prices
mid-form cannot change what a customer in that form is charged, and a forged
request cannot pay a penny.

---

## 8. Data requests: erasing a customer

A customer writes in and asks to be forgotten.

**Admin → Customers → open the customer → "Forget this customer".**

What it does, in one transaction:

- Replaces their name with "Forgotten customer".
- Replaces their email with a unique address on the reserved `.invalid` TLD, so
  nothing can ever be delivered to it and the `(business_id, email)` unique
  index still holds.
- Clears their phone number, their timezone, and the business's private notes
  about them.
- Clears the note they typed into their own booking form, and any internal note
  on their appointments.

**Their appointments stay.** That is deliberate and it is worth being able to
explain:

- `appointments.customer_id` is `ON DELETE RESTRICT`, and a `CHECK` constraint
  requires anything past `held` to have a customer. A hard delete is refused by
  the database.
- A completed appointment is also the *business's* record of a service they
  performed and money they took. Erasure does not reach into a third party's
  financial records.
- The payment identifiers are how a charge is reconciled months later.
  Destroying them would leave payments in Stripe that nothing here can explain.

After it runs there is nothing left in the database that says whose those
appointments were. The action is **not reversible** and the confirmation says
so. It is refused in the demo workspace.

If the customer also wants their data out of Stripe, that is a separate request
to make in the Stripe dashboard — this application cannot delete objects it
does not own.

---

## 9. Content Security Policy

The policy in `next.config.ts` allows Stripe's domains
(`js.stripe.com`, `hooks.stripe.com`, `checkout.stripe.com`, `api.stripe.com`)
so the payment step is not broken by it.

`script-src` includes `'unsafe-inline'`, and the reason is stated honestly in
the config: React streams a page by writing inline `$RC(...)` calls into the
document to reveal Suspense boundaries. Removing it means minting a nonce per
request in the Edge proxy, which this project deliberately does not do. The
CSP is therefore a strong defence against loading a *third-party* script and a
weak one against an injected inline one — and the second is covered by React
escaping every value it renders and by there being no `dangerouslySetInnerHTML`
anywhere in the codebase.

`Strict-Transport-Security` is sent **only** in production. Sending it in
development would pin `localhost` to https in the browser's HSTS store for two
years and break every other project on that machine.

---

## 10. Abuse limits, and how to tune them

The booking page is unauthenticated by design, so the public actions are rate
limited. Every rule lives in `src/server/booking/rate-limit.ts` with the
reasoning next to it.

| Action | Bounded by | Default |
| --- | --- | --- |
| Take a slot (any call) | IP | 60 per 5 min |
| **Create** a hold (not move one) | IP | 10 per 8 min |
| **Create** a hold on one business's one day | IP + business + date | 4 per 8 min |
| Submit details | IP | 12 per 10 min |
| Submit details | email | 6 per hour |
| Start checkout | IP | 20 per 10 min |
| Manage page and its actions | IP / token | 120 / 60 per 5 min |

Two things to understand before changing any of them:

- **The window on the hold rules must stay at least as long as a hold lives.**
  "At most N new holds per 8 minutes" is what makes "at most N concurrent
  holds" true. Shorten the window below the hold length and the concurrency cap
  silently stops being one. There is a test that asserts this.
- **Moving a hold costs nothing.** The cap is consumed only when a hold is
  created, because moving one releases the previous row in the same
  transaction. A customer comparing times all afternoon never hits it.

The limiter **fails open**: if it cannot count — database unreachable, table
missing on a half-migrated deploy — the request is allowed and the failure is
logged. A limiter that takes the booking page down when it cannot count has
caused more harm than the abuse it guards against.

**Known limitation.** `x-forwarded-for` is spoofable in general. Behind
Vercel's proxy the left-most entry is set by the platform and is trustworthy;
on a different host, check what your proxy does before relying on the IP
buckets. The email bucket and the per-appointment authorization do not depend
on it.

The `rate_limits` table is swept by the daily cron. Nothing depends on that
running — a stale row is reset in place by the next request from that subject.

---

## 11. Known limitations

Stated plainly rather than discovered later.

- **One `npm audit` finding is unfixable and is accepted.**
  `drizzle-kit` → `@esbuild-kit/esm-loader` → `esbuild@0.18.20`
  (GHSA-67mh-4wv8-2f99, moderate). The advisory is about esbuild's *dev
  server* accepting cross-origin requests. `drizzle-kit` uses esbuild only to
  transpile config at migration time and never starts that server, it is a
  `devDependency`, and it is not in the deployed bundle. `drizzle-kit@0.31.10`
  is the latest release and still carries the dependency, so there is no
  version to move to; `npm audit fix --force` would replace the migration
  tooling to fix an unreachable path.
- **The honeypot and the time-on-form check stop unsophisticated bots only.**
  Anything driving a real browser walks past both. They are free and they
  remove most of the traffic; the rate limits are what stop the rest. There is
  deliberately no CAPTCHA — it would put a puzzle in front of every real
  customer to inconvenience an attacker for an afternoon.
- **A manage link that does not work gives one answer.** Expired, mistyped and
  forged all produce the same page, naming no business. A different answer for
  a real-but-old token is an oracle, and an expired manage URL outlives the
  appointment in inboxes and screenshots.
- **There is no settings form for business details yet.** Timezone, slug and
  currency are fixed after onboarding, enforced by a database trigger.
- **A dead manage link is not constant-TIME.** Resolving a token that names a
  real-but-expired appointment does slightly more work than one that matches
  nothing, so the two are distinguishable by latency in principle. Exploiting
  it would mean measuring a database round trip over the network against a
  256-bit keyspace, with the IP limiter capping attempts — so the response
  bodies were made identical and the timing was left alone rather than padded
  with a delay that would be theatre.
- **The suite cannot be run twice at once.** Every integration file
  `TRUNCATE`s the shared tables, so two concurrent `npm test` processes destroy
  each other's fixtures and produce failures that look real. Run one.

---

## 12. Before you call it deployed

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

Then, against the deployed URL:

- [ ] Book something end to end with Stripe's test card `4242 4242 4242 4242`.
- [ ] Confirm the appointment flips to `confirmed` — that proves the webhook.
- [ ] Confirm the email arrives, and check `spf=pass dkim=pass dmarc=pass` in
      its headers.
- [ ] Open the calendar invite; the event should appear at the right time in
      your own timezone.
- [ ] Follow the manage link, reschedule, then cancel.
- [ ] `curl -sI https://<domain> | grep -i "content-security-policy\|strict-transport"`.
- [ ] Load `/manage/<something-invented>` and confirm it says nothing about any
      business.
