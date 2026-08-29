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
| `npm run test`      | Vitest (integration files need `TEST_DATABASE_URL`) |
| `npm run email`     | React Email preview on http://localhost:3001  |

## Email and calendar invites

Nothing is emailed inline with a booking. A booking transaction writes a row to `notifications` and
commits; a worker drains it, so a mail-provider outage can never roll back a confirmed appointment.

Every confirmation, reschedule and cancellation carries a calendar invitation with **one UID for the
appointment's whole life** and a **SEQUENCE that increments on every change**, so a rescheduled
appointment moves in the customer's calendar instead of appearing twice. A cancellation sends
`METHOD:CANCEL` and never a stale copy of the old invite alongside it. Because attachment handling
varies wildly between clients, each message also carries a hosted `.ics` link
(`/ics/[appointmentId]`) and a Google Calendar link.

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
