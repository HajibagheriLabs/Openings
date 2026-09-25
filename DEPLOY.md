# Deploying Openings

How to take this from a laptop to a public URL on **Vercel Hobby + Neon Free**,
in the order it has to happen, then how to prove it works — plus the
operational procedures that only matter once real people are using it.

Everything here costs nothing. Every step that happens in a dashboard is
marked **[dashboard]** and has to be done by the account owner. Every command
marked **[terminal]** has been run against a real Neon database and a local
production build (`next build` + `next start`) — not yet against the deployed
one, which does not exist until you do the dashboard steps. Where something is
a known limitation it says so.

1. [Before you start](#1-before-you-start)
2. [Deploy, step by step](#2-deploy-step-by-step)
3. [The live smoke test](#3-the-live-smoke-test)
4. [Why reminders go through QStash: the Hobby cron constraints](#4-why-reminders-go-through-qstash-the-hobby-cron-constraints)
5. [Email deliverability — SPF, DKIM and DMARC](#5-email-deliverability--spf-dkim-and-dmarc)
6. [What is logged, and what is deliberately not](#6-what-is-logged-and-what-is-deliberately-not)
7. [Reconstructing the money trail](#7-reconstructing-the-money-trail)
8. [Data requests: erasing a customer](#8-data-requests-erasing-a-customer)
9. [Content Security Policy](#9-content-security-policy)
10. [Abuse limits, and how to tune them](#10-abuse-limits-and-how-to-tune-them)
11. [Known limitations](#11-known-limitations)

---

## 1. Before you start

**Accounts:** GitHub, Vercel (Hobby), Neon (Free), Stripe (test mode only),
Resend, Upstash (QStash). None needs a card.

### ⚠ Vercel Hobby cannot deploy from an organization repository

A Hobby project **cannot be connected to a private repository owned by a
GitHub organization** — the import either refuses or, worse, works once and
then starts failing. Pro can; Hobby cannot.

This repository is `github.com/HajibagheriLabs/Openings`. Despite the name,
`HajibagheriLabs` is a **personal** GitHub account (GitHub's API reports its
type as `User`, not `Organization`), and the repository is public, so Hobby can
import it. If it is ever transferred to an organization, move it back to a
personal account (or keep it public) before touching Vercel.

### Pick one region and use it twice

Vercel Hobby runs functions in **one** region — by default Washington, D.C.
(`iad1`). Put the Neon database in **AWS US East 1 (N. Virginia)** to match.

This is not a nicety. Rendering a booking page is several *sequential*
database round trips, and a transaction is several more. Measured from a
client an ocean away from its database: 2.8 s to open a connection and about
300 ms per query, which turns one page into several seconds. Same-region, a
round trip is a millisecond or two. If you prefer Europe, put the functions in
Frankfurt (`fra1`) and Neon in AWS EU Central 1 instead — the point is that
they agree.

---

## 2. Deploy, step by step

Throughout, **`PRODUCTION_URL`** means the project's production origin, e.g.
`https://openings.vercel.app` — `https://`, no trailing slash, no path.

### Step 1 — Import the repository into Vercel [dashboard]

1. <https://vercel.com/new> → **Continue with GitHub**.
2. When asked, install the Vercel GitHub app on the **HajibagheriLabs** account
   and grant it **Only select repositories → Openings**.
3. Import **Openings**. Vercel detects Next.js; leave the root directory, build
   command and install command at their defaults.
4. Name the project `openings`. The production URL becomes
   `https://openings.vercel.app` if that name is free, otherwise Vercel adds a
   suffix. **Write down what it actually is** (Project → Settings → Domains) —
   several values below must match it exactly.
5. Click **Deploy**. This first deployment has no database and no secrets, so
   it will either fail or serve a site that errors. Both are fine: it exists to
   create the project and its URL.
6. Project → Settings → Build and Deployment → **Node.js Version → 24.x**, the
   version CI and development use.

### Step 2 — Attach Neon [dashboard]

1. Vercel project → **Storage** → **Create Database** → **Neon**.
2. Plan **Free**, region **AWS US East 1** (see §1), name `openings`.
3. Connect it to the project for the **Production** environment. (Preview is
   covered in §11 — leave it off.)

The integration adds `DATABASE_URL` (the **pooled** connection string — its
host contains `-pooler`), `DATABASE_URL_UNPOOLED` (the direct one) and a set of
`PG*` / `POSTGRES_*` variables to the project. The application reads only
`DATABASE_URL`; the unpooled one is for migrations in Step 5.

**`btree_gist` needs no dashboard action.** Migration `0000` creates it and
Neon's default role is allowed to. Step 5 proves it is there rather than
assuming so.

> **Already have a Neon account?** Creating a separate Neon project in the Neon
> console and pasting its pooled connection string into `DATABASE_URL` yourself
> works identically. What does **not** work is reusing the development
> database: the seed tears down and rebuilds the demo businesses, and the test
> database is truncated by the suite.

### Step 3 — Set every environment variable [dashboard]

Vercel project → **Settings → Environment Variables**. Scope every one to
**Production**. Tick **Sensitive** on everything except the two `NEXT_PUBLIC_*`
values and `EMAIL_FROM`.

| Variable | Value | Where it comes from |
| --- | --- | --- |
| `DATABASE_URL` | pooled Neon string | **Already set** by the Neon integration in Step 2. |
| `BETTER_AUTH_SECRET` | 32+ random bytes | Generate a **fresh** one — never the development value: `openssl rand -base64 32`. Rotating it later signs every owner out **and invalidates every manage link already emailed** (they are derived from it). |
| `BETTER_AUTH_URL` | `PRODUCTION_URL` | The URL from Step 1. Better Auth issues its callbacks against it and trusts requests only from it. |
| `NEXT_PUBLIC_APP_URL` | `PRODUCTION_URL` | Same value. Every link in every email, Stripe's return URLs and the QStash delivery target are built from it. It is **inlined at build time**, so changing it needs a redeploy, not just a save. |
| `CRON_SECRET` | random | `openssl rand -hex 32`. Vercel sends it to the cron as `Authorization: Bearer …` on its own; without it the sweep refuses to run in production. |
| `STRIPE_SECRET_KEY` | `sk_test_…` | Stripe Dashboard, **Test mode on** → Developers → API keys → Secret key. The app refuses a live key. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_test_…` | Same page → Publishable key. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | **Leave until Step 6** — it is issued when the webhook endpoint is created. |
| `RESEND_API_KEY` | `re_…` | Resend → API Keys → Create API key, permission **Sending access**. |
| `EMAIL_FROM` | `Openings <onboarding@resend.dev>` | Resend's shared testing sender, until you verify a domain — see Step 7 for what that limits. Then `Your Name <bookings@your-domain>`. |
| `QSTASH_URL` | region origin | Upstash console → QStash → **Quickstart**. `https://qstash.upstash.io` for the EU region, `https://qstash-us-east-1.upstash.io` for US. **An account in the US region must set this**, or every publish goes to the EU endpoint and is refused. |
| `QSTASH_TOKEN` | token | Same Quickstart panel. |
| `QSTASH_CURRENT_SIGNING_KEY` | `sig_…` | Same panel. Verifies that a delivery really came from QStash. |
| `QSTASH_NEXT_SIGNING_KEY` | `sig_…` | Same panel. Used during key rotation; both are required. |
| `DEMO_OWNER_EMAIL` | an inbox you read | Your choice. The seed creates the salon owner with it (the clinic owner is the same address with `+clinic`), and `/demo` signs visitors in as that owner. |
| `DEMO_OWNER_PASSWORD` | 10+ characters | Your choice. Must match what the seed is given in Step 5. |

**Not** set in Vercel: `TEST_DATABASE_URL` and the `E2E_*` variables (tests
only), and `NODE_ENV` (Vercel sets it).

### Step 4 — Fluid Compute, region and the cron [dashboard + repo]

**Fluid Compute is required.** The owner's live agenda is a Server-Sent Events
stream held open for up to five minutes, and the route declares
`maxDuration = 300` to claim it. On Hobby, 300 seconds is the ceiling *with*
Fluid Compute; without it the ceiling is 60 seconds.

- `vercel.json` sets `"fluid": true`, so every deployment of this repository
  gets it whatever the dashboard says.
- Confirm anyway: Settings → **Functions** → **Fluid Compute: Enabled**. (It
  has been the default for new projects since April 2025.)
- Same page → **Function Region** → Washington, D.C., USA (`iad1`) — or
  whichever region you matched Neon to in §1.

The stream retires itself after 280 seconds and the browser reconnects at
once, so the platform's 300-second limit is a backstop a healthy connection
never reaches (`STREAM_MAX_LIFETIME_MS` in `src/lib/admin/calendar.ts`).

**The cron is already declared** in `vercel.json`:

```json
{ "path": "/api/cron/daily", "schedule": "0 3 * * *" }
```

It appears under Settings → **Cron Jobs** after the next production deploy,
with a **Run** button for triggering it by hand. Read §4 for what Hobby does and
does not promise about it — that section is why reminders do not depend on it.

### Step 5 — Migrate, verify, seed [terminal]

Run from your machine, against the production database, **once**.

Create `.env.production.local` in the repository root. It is covered by the
`.env*` rule in `.gitignore` and is never committed.

```bash
# .env.production.local — production values, for these three commands only.
# The DIRECT connection (DATABASE_URL_UNPOOLED in Vercel), not the pooled one:
# migrations are DDL inside a transaction, which belongs on a real session.
DATABASE_URL='postgresql://…@ep-….us-east-1.aws.neon.tech/neondb?sslmode=require'
# The same value as in Vercel. The seed derives the demo appointments' manage
# links from it; a different secret seeds links that production cannot open.
BETTER_AUTH_SECRET='…'
DEMO_OWNER_EMAIL='…'
DEMO_OWNER_PASSWORD='…'
```

Then, in Git Bash (or any POSIX shell), from the repository root:

```bash
set -a && . ./.env.production.local && set +a && npm run db:migrate && npm run db:verify && npm run db:seed
```

Values exported this way win over `.env.local` — every script loads that file
without overriding what is already set — so all three commands hit
production. **Close that terminal afterwards**; it is still pointed at
production.

`db:verify` is the assertion that the database can refuse a double booking. It
reads the catalogue — not the migration table — and **exits non-zero naming
what is missing** if `btree_gist` is not installed, if
`appointments_no_overlap` does not exist, is not an exclusion constraint, is not
validated, or has the wrong shape, or if any migration is unapplied. A healthy
run looks like this:

```
  Checking database "neondb"

  ✓ btree_gist 1.8 is installed
  ✓ appointments_no_overlap: EXCLUDE USING gist (staff_id WITH =, slot WITH &&) WHERE ((status = ANY (ARRAY['held'::appointment_status, 'confirmed'::appointment_status])))
  ✓ 14 of 14 migrations applied

  The database will refuse an overlapping booking.
```

CI runs the same script against a database migrated from nothing on every
push, so the script itself is known to work.

The seed builds two businesses in two timezones — **Rosa's Hair Studio** in
`Europe/Lisbon` (`/book/rosas-hair-studio`) and **Northside Family Clinic** in
`America/Chicago` (`/book/northside-family-clinic`) — with staff, weekly hours,
time off and a fortnight of appointments either side of today. Re-running it
re-anchors the demo to the new today.

### Step 6 — Stripe webhook, in test mode [dashboard]

1. Stripe Dashboard → make sure **Test mode** is on (the toggle, or the
   test-mode sandbox you use).
2. **Developers → Webhooks → Add destination** (Stripe also calls these *event
   destinations*).
3. Events from **Your account**. If it asks for an API version, choose
   **`2026-08-26.dahlia`** — the version the application pins
   (`STRIPE_API_VERSION` in `src/lib/payments/stripe.ts`).
4. Select exactly three events:
   - `checkout.session.completed`
   - `checkout.session.expired`
   - `charge.refunded`
5. Destination type **Webhook endpoint**, URL
   **`PRODUCTION_URL/api/webhooks/stripe`**. Create it.
6. On the endpoint's page, **Reveal** the signing secret (`whsec_…`) and paste
   it into Vercel as `STRIPE_WEBHOOK_SECRET`.

This secret is **not** the one `stripe listen` prints locally; every endpoint
has its own. A mismatch makes every event fail signature verification, and the
booking stays "confirming" forever — the endpoint's page in Stripe shows the
400s.

**The success redirect is not proof of payment.** An appointment becomes
`confirmed` only inside the verified webhook.

The Stripe account may be shared with another project. Every object this
application creates carries `metadata.app=openings` and the handler ignores
anything without it, so another app's events arriving here are harmless. For
local work, narrow `stripe listen` the same way:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe --events checkout.session.completed,checkout.session.expired,charge.refunded
```

### Step 7 — Resend [dashboard]

There is **no URL to configure in Resend.** "Pointing it at production" is two
variables in Vercel: `RESEND_API_KEY` and `EMAIL_FROM`. Every link inside every
message — the manage link, the calendar download, the Google Calendar button —
is built from `NEXT_PUBLIC_APP_URL`, which is why Step 3 sets it to the
production URL. (Resend's own webhooks are not used.)

What changes is **which sender you use**, and it matters more than it looks:

| | Shared testing domain | Your verified domain |
| --- | --- | --- |
| `EMAIL_FROM` | `Openings <onboarding@resend.dev>` | `Name <bookings@your-domain>` |
| Setup | None | Three DNS records — §5 |
| **Who can receive** | **Only the address that owns the Resend account.** Anything else is refused with a 403 ("you can only send testing emails to your own email address"). | Anybody. |
| Deliverability | Shared and rate-limited; fine for a demo, not for customers | Authenticated with SPF, DKIM and DMARC as your own domain |

So on the testing domain, **book with the Resend account's own email address**
during the smoke test, or no confirmation will arrive. The seeded businesses'
"new booking" notices go to their contact addresses, which Resend will refuse;
those outbox rows are marked failed and retried with backoff. That is expected
noise, not a fault, and it disappears with a verified domain.

### Step 8 — QStash [dashboard]

1. <https://console.upstash.com/qstash> → **Quickstart** (or the environment
   tab). Copy `QSTASH_URL`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY` and
   `QSTASH_NEXT_SIGNING_KEY` into Vercel (Step 3).
2. **The schedule target needs no console configuration.** At the moment a
   booking is confirmed, the application publishes one QStash message per
   reminder, for its exact minute, to
   **`PRODUCTION_URL/api/notifications/deliver`** — derived from
   `NEXT_PUBLIC_APP_URL`. The delivery route verifies QStash's signature
   against that same URL, so `NEXT_PUBLIC_APP_URL` being exactly the production
   origin is what makes deliveries both reach the worker and be accepted.
3. With `NEXT_PUBLIC_APP_URL` on `localhost`, scheduling is switched off on
   purpose — QStash cannot reach a laptop, and messages would pile up in its
   dead-letter queue. Production does not have that problem.

After the redeploy, **Admin → Settings** states which delivery mode is running:
"Scheduled per booking" or "Daily catch-up only". If it says the catch-up, a
variable is missing or `NEXT_PUBLIC_APP_URL` is not the production URL.

**Optional:** in the QStash console, create a **Schedule** that POSTs to
`PRODUCTION_URL/api/cron/daily` every hour (`0 * * * *`). The daily route
accepts a QStash-signed call as well as Vercel's bearer, so this turns the
safety net's worst case from "a day late" into "an hour late" for 24 messages a
day, well inside the free tier.

### Step 9 — Redeploy, then run the scripted smoke check [dashboard + terminal]

Environment variables apply only to deployments made **after** they are saved,
and `NEXT_PUBLIC_*` values are compiled in. So:

1. Vercel project → **Deployments** → the latest → **⋯ → Redeploy**.
2. When it is live:

```bash
npm run smoke -- https://openings.vercel.app
```

(with your actual `PRODUCTION_URL`). It proves, without changing anything:
the security headers are on the response and the CSP allows Stripe; both demo
businesses render, each carrying **its own** timezone; an invented manage link
names no business and is `noindex`; the cron, the Stripe webhook, the reminder
worker and the agenda stream all refuse a stranger — and it tells a *missing*
`CRON_SECRET` or `STRIPE_WEBHOOK_SECRET` apart from a wrong caller. It exits
non-zero on any failure.

---

## 3. The live smoke test

The part that needs a person, in this order. Each step says what proves it
and, if it fails, where to look first.

Use two browsers (or one normal window and one private window) and a phone.
On the Resend testing domain, use **the Resend account's own address** as the
customer email.

1. **The business page loads.** Open `PRODUCTION_URL/book/rosas-hair-studio`.
   The name, address, opening hours and services render.
   *If not:* Vercel → Deployments → the deployment → **Logs**. A database error
   means `DATABASE_URL`; an environment error names the variable.
2. **Pick a service, a staff member and a date.** The month picker shows
   days with availability as selectable and the rest as not.
3. **The Ribbon shows a believable day.** Open times inside the salon's
   hours, booked appointments carved in with initials, lunch or time off
   hatched, nothing before now. The header says times are in `Europe/Lisbon`
   and, if you are elsewhere, how far that is from you.
4. **Select a time and watch the hold start.** The segment turns solid, the
   depleting bar appears along its top edge, and the sticky summary counts down
   from 8:00.
5. **Open the same day in the second browser.** The time you are holding is
   **not** offered there — it is hatched as held by someone else. This is the
   exclusion constraint working across two sessions.
6. **Fill in details** — the Resend account's email — tick the policy and
   continue. (Wait a few seconds on the form first: a submit within three
   seconds of taking the slot is refused as a bot.)
7. **Pay with `4242 4242 4242 4242`**, any future expiry, any CVC, any
   postcode. Stripe Checkout loads — which also proves the CSP allows it.
8. **Land on confirmed.** The return page may say it is confirming for a
   second or two, then "You are booked in".
   *If it stays confirming:* the webhook is not arriving. Stripe → Developers →
   Webhooks → the endpoint → its recent deliveries show the status code.
9. **The confirmation email arrives with a calendar invite.** Check the
   footer names the business and says why the message arrived. The `.ics`
   attachment is `PRODID:-//Openings//Booking//EN`.
10. **Add it to a real calendar** — open the attachment, or use the Google
    Calendar link in the email. It lands at the right time in your own
    timezone.
11. **Reschedule from the manage link** in the email. Pick a new time and
    confirm. A reschedule email arrives with an updated invite carrying the
    same `UID` and a higher `SEQUENCE` — open it and the calendar entry
    **moves** rather than duplicating.
12. **Cancel from the manage link.** Then refresh the day in the second
    browser: the slot is **open again immediately** — not after a cron, not
    after the hold would have expired. A cancellation email arrives and, where
    the calendar honours `METHOD:CANCEL`, the entry is removed.
13. **Sign in as the owner** — `PRODUCTION_URL/demo`, or `/sign-in` with
    `DEMO_OWNER_EMAIL` / `DEMO_OWNER_PASSWORD`. The agenda for today shows the
    booking you made, then cancelled, and scrolls to now.
14. **Book publicly again with the agenda open** in the other browser. The
    new appointment appears on the agenda **without a refresh**, within a few
    seconds. That is the SSE stream, and Fluid Compute is what keeps it alive.
15. **Check the other business shows its own timezone.** Open
    `PRODUCTION_URL/book/northside-family-clinic`: its times are in
    `America/Chicago`, six hours from Lisbon, and its hours read as Chicago's
    local hours, not shifted by the server's zone.
16. **Test on a phone.** The booking flow is one column, time targets are
    comfortably tappable, the sticky summary never covers the button, and the
    countdown is readable.

When all sixteen pass, it is deployed.

---

## 4. Why reminders go through QStash: the Hobby cron constraints

The daily cron in `vercel.json` is a **safety net, not the reminder
mechanism**, and the reason is what Vercel Hobby promises about crons:

- **Once per day, at most.** A Hobby project's cron expressions may not fire
  more than daily; anything more frequent fails the deployment.
- **Anywhere within the hour.** A job declared for `0 3 * * *` fires at some
  point between 03:00 and 03:59. The minute is not guaranteed.
- **UTC only.** The schedule is evaluated in UTC — there is no timezone
  setting — so 03:00 is 04:00 in Lisbon in summer and 22:00 the previous day in
  Chicago.
- **Production deployments only.** Preview deployments never run crons.

"Remind the customer 24 hours before their appointment" needs a resolution of
minutes, in the business's timezone. A job with a resolution of a day, in UTC,
with an hour of jitter, can only send such a reminder hours early or after the
appointment has happened. So each reminder is published to **QStash** at booking
time for its exact instant (Step 8), and the daily cron catches whatever QStash
did not deliver: a failed publish, an expired token, a paused queue. It also
reclaims expired holds and prunes old rate-limit and webhook-event rows.
Correctness never depends on it running.

Without QStash configured, the product still works: reminders fall to the
daily sweep and arrive up to a day late, never lost. Admin → Settings says
which mode is running.

---

## 5. Email deliverability — SPF, DKIM and DMARC

**Transactional mail from an unauthenticated domain goes to spam, and a booking
confirmation in a spam folder is a customer who does not turn up.** This is the
step most likely to be skipped and the one whose failure is least visible.
Needed as soon as you move off the shared testing domain (Step 7).

### Verify the sending domain in Resend

Resend → Domains → Add Domain. It issues DNS records. Add them at the
registrar, then wait for Resend to show the domain as **Verified**.

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

It must be **on the verified domain**. Redeploy after changing it.

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
so the payment step is not broken by it. `npm run smoke` asserts they are on
the live response, and step 7 of §3 proves Checkout loads under it.

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

Security headers are set in `next.config.ts`, not in `vercel.json`, so they
apply to `next start` and to local development too. A header that only exists
in production is a header nobody tests.

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
| Submit details sooner than 3 s after taking the slot | — | refused as automated |
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

- **Preview deployments are not set up.** A preview has its own URL, which
  does not match `BETTER_AUTH_URL`, so owner sign-in fails there; crons never
  run on previews; and pointing a preview at the production database would let
  unreviewed code write to it. Production only, deliberately. Making previews
  work means a Neon branch per preview and per-environment URLs.
- **The first request after a quiet spell is slow.** Neon Free scales its
  compute to zero when idle and takes a moment to wake — normally a second or
  two when the function and the database share a region. The connection pool
  waits up to ten seconds (`src/db/client.ts`), so it is a slow first page, not
  an error. Across an ocean, waking plus the TLS handshake can exceed that and
  the first page errors; that is one more reason for §1's advice on regions.
- **The agenda stream reconnects every 280 seconds.** Invisible to the owner —
  the client reconnects at once and re-reads the day — but it is one reconnect
  every few minutes per open agenda, by design (§2, Step 4).
- **Changing the production URL needs three updates and a redeploy:**
  `BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL`, and the Stripe webhook endpoint.
  Reminders already queued in QStash keep the old URL; they still arrive while
  the old `vercel.app` domain stays assigned to the project.
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
- **A dead manage link is not constant-TIME.** Resolving a token that names a
  real-but-expired appointment does slightly more work than one that matches
  nothing, so the two are distinguishable by latency in principle. Exploiting
  it would mean measuring a database round trip over the network against a
  256-bit keyspace, with the IP limiter capping attempts — so the response
  bodies were made identical and the timing was left alone rather than padded
  with a delay that would be theatre.
- **There is no settings form for business details yet.** Timezone, slug and
  currency are fixed after onboarding, enforced by a database trigger.
- **The suite cannot be run twice at once.** Every integration file
  `TRUNCATE`s the shared tables, so two concurrent `npm test` processes destroy
  each other's fixtures and produce failures that look real. Run one.
- **The browser suite needs a nearby database.** Its steps give a page five
  seconds to appear. Against a database hundreds of milliseconds away, the
  deposit path's details page can take longer than that and the card spec
  fails on timing alone; CI runs it against a local container and is not
  affected.

Before any deploy, locally:

```bash
npm run typecheck && npm run lint && npm test && npm run build
```
