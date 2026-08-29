# Openings

A booking engine for local service businesses — clinics, salons, consultants.

A visitor picks a service, optionally a staff member, a date and a time. The slot is **held** while
they enter their details and pay a deposit; on payment the appointment is confirmed and a
confirmation email with a calendar invite goes out. The business owner gets an admin area with a live
agenda, manual booking, blocked time, and service/staff/hours management.

## The two hard parts

**Double-booking is prevented by the database, not the application.** A Postgres `EXCLUDE USING gist`
constraint over `(staff_id, slot)` rejects overlapping appointments at any isolation level, with no
locking code. The application catches SQLSTATE `23P01` and turns it into a friendly "that time was
just taken". Booking buffers live inside the stored range, so the constraint enforces them for free.

**All time math happens on the server, in the business timezone.** Recurring weekly hours are stored
as plain local times so that "we open at 9" survives a DST change. The API returns ISO instants plus
an IANA timezone; the client formats them with `Intl.DateTimeFormat` and does no date arithmetic.

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Tailwind CSS v4 · shadcn/ui ·
Drizzle ORM + Postgres · Better Auth · Stripe Checkout · Resend + React Email · Upstash QStash ·
Temporal (via `temporal-polyfill`) · Zod

## Getting started

```bash
npm install
```

Copy the environment template and fill in at least `DATABASE_URL`, `BETTER_AUTH_SECRET`,
`BETTER_AUTH_URL` and `NEXT_PUBLIC_APP_URL`:

```bash
cp .env.example .env.local
```

Everything else is optional — without a Stripe key deposits are skipped, and without a Resend key the
mailer prints messages to the console, so the whole flow still runs offline.

```bash
npm run dev
```

| Command             | What it does                                  |
| ------------------- | --------------------------------------------- |
| `npm run dev`       | Dev server on http://localhost:3000           |
| `npm run build`     | Production build                              |
| `npm run start`     | Serve the production build                    |
| `npm run typecheck` | Generate route types, then `tsc --noEmit`     |
| `npm run lint`      | ESLint                                        |
| `npm run test`      | Every Vitest file                             |
| `npm run test:unit` | No database. Under ten seconds                |
| `npm run test:integration` | Needs `TEST_DATABASE_URL`              |
| `npm run test:e2e`  | Playwright. Needs `E2E_DATABASE_URL`          |
| `npm run email`     | React Email preview on http://localhost:3001  |
| `npm run db:migrate` | Apply migrations                             |
| `npm run db:seed`   | Build the demo workspace                      |

## Tests

The suite is ordered by what it would cost to get wrong, and the directory
names are the order: `1-concurrency`, `2-time`, `3-payments`, `4-invites`,
`5-policy`, `6-delivery`. Coverage is not the goal — see
[test/README.md](test/README.md), which also lists what is deliberately not
tested and why.

The integration files run against a real Postgres with `btree_gist`, because
the guarantee this project is built around is an exclusion constraint and there
is no mock of Postgres that can check one. They truncate tables between cases,
so `TEST_DATABASE_URL` is required and must differ from `DATABASE_URL`.

`e2e/` is Playwright: the one path where money changes hands, through a real
browser, ending with a second browser context confirming the slot is gone. The
card step runs when Stripe test keys are present and skips with a reason when
they are not.

CI runs on every push and pull request: typecheck and lint, then the unit and
integration suites against a Postgres service container, then Playwright.

## The demo workspace

```bash
npm run db:migrate
npm run db:seed
```

The seed builds **two businesses in two timezones** — a salon in `Europe/Lisbon` and a clinic in
`America/Chicago`. Two zones is the point: they are six hours apart, they change their clocks on
different weekends, and both publish their opening hours as local wall-clock times. If any of the
scheduling maths happened in the server's timezone, or on raw milliseconds, one of the two calendars
would be visibly wrong.

Each gets three to five services with varied durations and buffers, two or three staff on staggered
rotas with different service assignments, realistic time off, and a fortnight of appointments either
side of today at a density that reads as an ordinary working week. Three days out, the salon has a
deliberately awkward day: a lunch break, a blocked afternoon, and a 150-minute service whose buffers
push it to 195 — so it fits in the morning and nowhere else, while shorter services still fit around
the break.

It is idempotent and deterministic. Every choice comes from a fixed seed rather than `Math.random`,
and the previous demo is torn down before the next is built, so two runs produce the same businesses
re-anchored to the new today. **Re-run it to move the fortnight forward.**

`/demo` signs a visitor in as the salon owner and lands them on today's agenda, with a permanent
banner saying the bookings are not real. The public booking pages stay open to everyone, and anyone
can complete a booking with Stripe's test card — which is printed on the landing page next to the
button that needs it.

Demo restrictions are enforced by a database trigger (migration `0013`) as well as by the Server
Actions, so no action written later can forget them: the timezone, slug and currency are fixed, and
the business, its services, its staff and its customers cannot be deleted. Everything else works
normally — booking, cancelling, blocking time out, editing hours. Bookings visitors leave behind are
cleared by the daily job after 24 hours; the seeded fortnight is recognised by its calendar UID
domain and left alone.

## Email and calendar invites

Nothing is emailed inline with a booking. A booking transaction writes a row to `notifications` and
commits; a worker drains it, so a mail-provider outage can never roll back a confirmed appointment.

Every confirmation, reschedule and cancellation carries a calendar invitation with **one UID for the
appointment's whole life** and a **SEQUENCE that increments on every change**, so a rescheduled
appointment moves in the customer's calendar instead of appearing twice. A cancellation sends
`METHOD:CANCEL` and never a stale copy of the old invite alongside it. Because attachment handling
varies wildly between clients, each message also carries a hosted `.ics` link
(`/ics/[appointmentId]`) and a Google Calendar link.

## Guests manage their own appointments

Customers never have an account. Every booking email links to `/manage/<token>`, where the token is a
bearer credential and the whole of the authorization — only its SHA-256 is stored, and the route finds
the appointment by hashing what it is given. Links expire 60 days after the appointment ends, derived
from `ends_at` rather than stored, so a rescheduled booking cannot keep a stale expiry. **An invalid
or expired link is never a bare 404**: an expired one names the business and its contact details, and
an unknown one explains what probably went wrong.

From that page a customer can **move** or **cancel**, when the policy allows. Both share one window —
the notice the business asks for — because otherwise the cancellation policy is walked around by
moving the appointment to next month and cancelling it from there. A move is one atomic UPDATE
arbitrated by the exclusion constraint, so a lost race leaves the customer with the appointment they
started with rather than none; it bumps `ics_sequence`, sends an updated invite under the same UID,
re-queues the reminder, and tells the owner. A cancel frees the slot immediately, sends
`METHOD:CANCEL`, withdraws the reminder, refunds the deposit when the business's policy says to — and
says on screen, before the button, when it does not. Both are idempotent in SQL, so a double-clicked
Cancel cannot attempt two refunds. The route is rate-limited by token and by IP.

## Scheduled delivery

**A Vercel Hobby project may run at most one cron per day, and not at a guaranteed minute.** That is
unusable for "24 hours before the appointment", so the cron is not the mechanism. Each reminder is
scheduled individually when the booking is confirmed: an Upstash QStash message with a `notBefore` of
the reminder's exact instant, addressed to `POST /api/notifications/deliver` and carrying the
notification id. The delivery is authenticated by QStash's signature over the raw body. Its message
id is stored on the row, so moving or cancelling the appointment can call it off.

Reminder timing is a business setting, default a day before. A booking made inside that window gets
no reminder — the appointment is sooner than the reminder would be.

`GET|POST /api/cron/daily` is the **safety net, not the mechanism**: it delivers whatever the
scheduler did not, reclaims expired holds, and forgets old Stripe event ids. Correctness does not
depend on it running. It is protected by `CRON_SECRET` as a bearer token, and also accepts a QStash
signature.

**Without QStash configured the product still works.** Nothing is scheduled, anything already due is
sent inline the moment a booking is confirmed, and reminders fall to the daily sweep — up to a day
late, never lost. The admin settings page states which mode is running.

## Design

The design system is called **Daybook**: warm grey workspace, white surfaces, one deep verdigris
accent, and time drawn as a proportional ribbon of material. Slot states are encoded by fill, pattern
and value — never by hue — so the grid stays readable for colourblind users. Every token lives in
`src/app/globals.css`, and nothing in the interface uses a colour that is not declared there.

## Layout

```
src/app                 routes (App Router)
src/components          application components
src/components/ui       shadcn/ui primitives
src/db                  Drizzle schema and client
src/lib/scheduling      availability algorithm and all time math
src/lib/payments        Stripe
src/lib/notifications   mailer and outbox
src/server              server actions and route handlers
emails                  React Email templates
```
