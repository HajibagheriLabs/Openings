import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";
import { eq, sql } from "drizzle-orm";

import { createDb } from "@/db/client";
import {
  accounts,
  appointments,
  availabilityRules,
  businesses,
  customers,
  services,
  serviceStaff,
  staff,
  timeOff,
  users,
  type AppointmentStatus,
} from "@/db/schema";
import { deriveManageToken } from "@/lib/notifications/manage-link";
import { hashManageToken } from "@/lib/scheduling/booking";
import { buildBlockingRange, toTstzRangeLiteral } from "@/lib/scheduling/slot";
import { Temporal } from "@/lib/scheduling/temporal";
import { SEED_ICS_DOMAIN } from "@/server/demo/tidy";

/* ===========================================================================
   THE DEMO SEED
   ---------------------------------------------------------------------------
   Two businesses, in two timezones, with a fortnight of history and a
   fortnight of diary. It exists so that somebody who has never seen this
   product can open a URL and find a working business rather than an empty
   grid — and so that the one thing this engine is actually about, timezone-
   correct scheduling, is visible rather than asserted.

   TWO TIMEZONES IS THE POINT. A salon in Europe/Lisbon and a clinic in
   America/Chicago are six hours apart, observe daylight saving on different
   weekends, and publish their hours as local wall-clock times that mean
   different instants in June and in December. If any of the scheduling maths
   were done in the server's timezone, or on raw milliseconds, one of these two
   calendars would be visibly wrong. Neither is.

   IT IS IDEMPOTENT AND DETERMINISTIC. Running it twice produces the same two
   businesses with the same staff, the same services and the same appointments
   — the previous demo is torn down first, and every "random" choice comes from
   a seeded generator rather than Math.random. Two runs an hour apart differ
   only in where "today" falls, which is the whole reason to re-run it.

   IT USES THE APPLICATION'S OWN CODE for anything that matters: the blocking
   range with its buffers, the tstzrange literal, the manage-token derivation.
   A seed that built those itself would be a second implementation nobody
   tests, and the day it disagreed about a buffer the demo would quietly show
   data the product could not have produced. See scripts/loader.mjs.
   =========================================================================== */

/* ---------------------------------------------------------------------------
   Configuration
--------------------------------------------------------------------------- */

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Not present. The checks below say what is actually missing.
  }
}

function required(name: string, hint: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    console.error(`\n  ${name} is not set.\n  ${hint}\n`);
    process.exit(1);
  }

  return value;
}

const DATABASE_URL = required(
  "DATABASE_URL",
  "Copy .env.example to .env.local and point it at your database.",
);

const DEMO_OWNER_EMAIL = required(
  "DEMO_OWNER_EMAIL",
  "Set it in .env.local — it is the address you will sign in to the demo with.",
);

const DEMO_OWNER_PASSWORD = required(
  "DEMO_OWNER_PASSWORD",
  "Set it in .env.local. At least 10 characters, the same rule the sign-up form uses.",
);

if (DEMO_OWNER_PASSWORD.length < 10) {
  console.error(
    "\n  DEMO_OWNER_PASSWORD must be at least 10 characters — the same rule the\n" +
      "  sign-up form enforces, so the seeded account can actually sign in.\n",
  );
  process.exit(1);
}

/**
 * The clinic's owner address, derived from the one in configuration.
 *
 * Two businesses need two owners: `getOwnedBusiness` resolves ONE business per
 * signed-in user, so a single account owning both would show one of them in
 * the admin area and silently hide the other. Plus-addressing keeps it to one
 * configured value and one real inbox.
 */
const [localPart, domain] = DEMO_OWNER_EMAIL.split("@");
const CLINIC_OWNER_EMAIL = `${localPart}+clinic@${domain}`;

/**
 * The issuer Better Auth stamps on an email-and-password account.
 *
 * Not "credential" — the provider id is that, and the issuer is the synthetic
 * local one derived from it. See the note where it is written.
 */
const CREDENTIAL_ISSUER = "local:credential";

/* ---------------------------------------------------------------------------
   A generator that gives the same answers every time
--------------------------------------------------------------------------- */

/**
 * mulberry32 — small, fast, and deterministic from a 32-bit seed.
 *
 * `Math.random()` would make every run a different business, so a screenshot
 * would not match the next person's demo and a bug reproducible on Tuesday
 * would be gone by Wednesday. The seed is a constant, written down here, and
 * that is the whole reason this is not one line of Math.random.
 */
function mulberry32(seed: number) {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Written down, not generated. Change it and the demo becomes a different
 *  — but equally reproducible — business. */
const SEED = 20260829;

const random = mulberry32(SEED);

/** An integer in [0, max). */
const randomInt = (max: number) => Math.floor(random() * max);

/** One element, chosen deterministically. */
const pick = <T,>(items: readonly T[]): T => items[randomInt(items.length)];

/** True with the given probability. */
const chance = (probability: number) => random() < probability;

/* ---------------------------------------------------------------------------
   The two businesses, described the way a person would describe them
--------------------------------------------------------------------------- */

interface SeedService {
  key: string;
  name: string;
  description: string;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  priceCents: number;
  depositType: "none" | "flat" | "percent";
  depositValue: number;
}

interface SeedStaff {
  key: string;
  name: string;
  initials: string;
  email: string;
  /** Local wall-clock hours, per weekday (0 = Sunday). Never instants. */
  hours: { weekday: number; startLocal: string; endLocal: string }[];
  /** Which services they perform, by key. */
  serviceKeys: string[];
}

interface SeedBusiness {
  slug: string;
  name: string;
  description: string;
  address: string;
  timezone: string;
  currency: string;
  contactEmail: string;
  contactPhone: string;
  ownerEmail: string;
  ownerName: string;
  slotGranularityMin: number;
  minLeadTimeMin: number;
  maxAdvanceDays: number;
  cancellationWindowHours: number;
  services: SeedService[];
  staff: SeedStaff[];
  /** Names the demo's customers are drawn from. */
  customerNames: string[];
}

/** Monday to Friday, and the weekend, as the weekday numbers the schema uses. */
const MON = 1;
const TUE = 2;
const WED = 3;
const THU = 4;
const FRI = 5;
const SAT = 6;

const weekly = (
  weekdays: number[],
  startLocal: string,
  endLocal: string,
) => weekdays.map((weekday) => ({ weekday, startLocal, endLocal }));

const SALON: SeedBusiness = {
  slug: "rosas-hair-studio",
  name: "Rosa's Hair Studio",
  description:
    "A three-chair salon in Príncipe Real. Cuts, colour and balayage, since 2011.",
  address: "Rua da Escola Politécnica 44\n1250-102 Lisboa\nPortugal",
  /* WESTERN EUROPE — UTC+0 in winter, UTC+1 in summer, and it changes on a
     different weekend from the United States. */
  timezone: "Europe/Lisbon",
  currency: "EUR",
  contactEmail: "hello@rosashair.example",
  contactPhone: "+351 21 000 0000",
  ownerEmail: DEMO_OWNER_EMAIL,
  ownerName: "Rosa Delgado",
  slotGranularityMin: 15,
  minLeadTimeMin: 120,
  maxAdvanceDays: 60,
  cancellationWindowHours: 24,
  services: [
    {
      key: "cut",
      name: "Cut and finish",
      description: "Consultation, wash, cut and a proper blow-dry.",
      durationMin: 45,
      bufferBeforeMin: 0,
      bufferAfterMin: 15,
      priceCents: 3_800,
      depositType: "percent",
      depositValue: 20,
    },
    {
      key: "balayage",
      name: "Balayage",
      description:
        "Hand-painted lightening, toner and a finish. Book the morning — it takes a while.",
      durationMin: 150,
      bufferBeforeMin: 15,
      bufferAfterMin: 30,
      priceCents: 14_500,
      depositType: "flat",
      depositValue: 3_000,
    },
    {
      key: "colour",
      name: "Colour and cut",
      description: "Full head colour or roots, then a cut and finish.",
      durationMin: 105,
      bufferBeforeMin: 0,
      bufferAfterMin: 20,
      priceCents: 9_500,
      depositType: "percent",
      depositValue: 20,
    },
    {
      key: "fringe",
      name: "Fringe trim",
      description: "In and out. Free if you had a cut here in the last six weeks.",
      durationMin: 15,
      bufferBeforeMin: 0,
      bufferAfterMin: 5,
      priceCents: 1_200,
      depositType: "none",
      depositValue: 0,
    },
  ],
  staff: [
    {
      key: "rosa",
      name: "Rosa Delgado",
      initials: "RD",
      email: "rosa@rosashair.example",
      hours: weekly([TUE, WED, THU, FRI, SAT], "09:00", "18:00"),
      serviceKeys: ["cut", "balayage", "colour", "fringe"],
    },
    {
      key: "tiago",
      name: "Tiago Alves",
      initials: "TA",
      /* A LATER SHIFT, deliberately. Two people with identical hours prove
         nothing about the agenda; two staggered ones make the ribbon's columns
         mean something at a glance. */
      hours: weekly([WED, THU, FRI, SAT], "11:00", "19:30"),
      email: "tiago@rosashair.example",
      serviceKeys: ["cut", "colour", "fringe"],
    },
    {
      key: "ines",
      name: "Inês Costa",
      initials: "IC",
      email: "ines@rosashair.example",
      /* Part time, and a longer Saturday. */
      hours: [
        ...weekly([TUE, THU, FRI], "09:30", "15:00"),
        { weekday: SAT, startLocal: "09:00", endLocal: "17:00" },
      ],
      serviceKeys: ["cut", "balayage"],
    },
  ],
  customerNames: [
    "Sofia Marques",
    "Miguel Ferreira",
    "Ana Rita Lopes",
    "João Pereira",
    "Beatriz Nunes",
    "Carlos Antunes",
    "Mariana Silva",
    "Duarte Ramos",
    "Helena Castro",
    "Pedro Sampaio",
    "Catarina Melo",
    "Rui Figueiredo",
    "Teresa Amaral",
    "Nuno Baptista",
    "Leonor Pinto",
    "Vasco Guerreiro",
  ],
};

const CLINIC: SeedBusiness = {
  slug: "northside-family-clinic",
  name: "Northside Family Clinic",
  description:
    "Family medicine on Lincoln Avenue. Same-week appointments, two doctors, no waiting room television.",
  address: "2140 W Lincoln Ave, Suite 3\nChicago, IL 60647\nUnited States",
  /* CENTRAL TIME — six hours behind Lisbon in the summer, and it changes on a
     different weekend. If any expansion in this product added a fixed offset,
     one of these two calendars would be an hour wrong for a fortnight a year. */
  timezone: "America/Chicago",
  currency: "USD",
  contactEmail: "front-desk@northsideclinic.example",
  contactPhone: "+1 312 555 0142",
  ownerEmail: CLINIC_OWNER_EMAIL,
  ownerName: "Marcus Hale",
  /* A TIGHTER GRID and a longer lead time than the salon: a clinic books on
     ten-minute boundaries and wants four hours' notice. Both are read by the
     availability engine, so the two booking pages behave differently. */
  slotGranularityMin: 10,
  minLeadTimeMin: 240,
  maxAdvanceDays: 45,
  cancellationWindowHours: 12,
  services: [
    {
      key: "new-patient",
      name: "New patient consultation",
      description: "A longer first appointment. Bring any records you have.",
      durationMin: 40,
      bufferBeforeMin: 5,
      bufferAfterMin: 10,
      priceCents: 18_000,
      depositType: "flat",
      depositValue: 4_000,
    },
    {
      key: "follow-up",
      name: "Follow-up",
      description: "A short review of something we have already seen you for.",
      durationMin: 20,
      bufferBeforeMin: 0,
      bufferAfterMin: 5,
      priceCents: 9_500,
      depositType: "none",
      depositValue: 0,
    },
    {
      key: "physical",
      name: "Annual physical",
      description: "The full hour: bloods, history, and time to actually talk.",
      durationMin: 60,
      bufferBeforeMin: 10,
      bufferAfterMin: 10,
      priceCents: 26_000,
      depositType: "percent",
      depositValue: 25,
    },
    {
      key: "vaccination",
      name: "Vaccination",
      description: "Flu, tetanus, travel jabs. In and out.",
      durationMin: 10,
      bufferBeforeMin: 0,
      bufferAfterMin: 5,
      priceCents: 4_500,
      depositType: "none",
      depositValue: 0,
    },
  ],
  staff: [
    {
      key: "marcus",
      name: "Dr. Marcus Hale",
      initials: "MH",
      email: "m.hale@northsideclinic.example",
      hours: weekly([MON, TUE, WED, THU], "08:00", "16:00"),
      serviceKeys: ["new-patient", "follow-up", "physical", "vaccination"],
    },
    {
      key: "priya",
      name: "Dr. Priya Raman",
      initials: "PR",
      email: "p.raman@northsideclinic.example",
      /* Mornings most of the week and one long evening clinic — the sort of
         rota that makes "whoever is free" mean something different at 08:00
         and at 18:00. */
      hours: [
        ...weekly([MON, WED, FRI], "07:30", "13:00"),
        { weekday: TUE, startLocal: "12:00", endLocal: "19:00" },
      ],
      serviceKeys: ["new-patient", "follow-up", "vaccination"],
    },
  ],
  customerNames: [
    "Denise Whitaker",
    "Andre Kowalski",
    "Yolanda Reyes",
    "Bill Hutchins",
    "Naomi Feldman",
    "Terrence Boyd",
    "Priscilla Nwosu",
    "Gary Lindqvist",
    "Erin O'Connell",
    "Hassan Karimi",
    "Marla Devine",
    "Kenji Watanabe",
    "Roberta Salas",
    "Doug Pemberton",
    "Simone Achebe",
    "Walt Grzesiak",
  ],
};

const BUSINESSES = [SALON, CLINIC];

/* ---------------------------------------------------------------------------
   How much history and diary to draw
--------------------------------------------------------------------------- */

/** A fortnight back and a fortnight forward, in local calendar days. */
const DAYS_BACK = 14;
const DAYS_FORWARD = 14;

/**
 * How often a free slot on the grid becomes an appointment.
 *
 * Not 1.0, and not 0.2. A calendar with no gaps looks like a screenshot and a
 * calendar with three appointments looks abandoned; somewhere near half reads
 * as a business having an ordinary week, and leaves real openings for a
 * visitor to book into.
 */
const BOOKING_DENSITY = 0.55;

/*
 * THE MARKER THAT TELLS SCENERY FROM A VISITOR'S BOOKING.
 *
 * Every appointment this script writes gets an `ics_uid` in the
 * `openings.demo-seed` domain. The nightly tidy-up clears demo bookings older
 * than a day so the workspace stays presentable, and this is how it knows to
 * leave the fortnight of history alone — otherwise the first daily run would
 * empty the demo it exists to keep tidy.
 *
 * It is imported from the sweep rather than redeclared here, because the two
 * have to agree exactly: a typo in one copy would make the seed invisible to
 * the sweep, or the sweep blind to everything.
 */

/* ---------------------------------------------------------------------------
   Time helpers — every one of them resolves through the business timezone
--------------------------------------------------------------------------- */

/** Local wall-clock on a local date, as a real instant. Never an offset. */
function instantAt(
  date: Temporal.PlainDate,
  timeZone: string,
  local: string,
): number {
  return date
    .toZonedDateTime({
      timeZone,
      plainTime: Temporal.PlainTime.from(local),
    })
    .epochMilliseconds;
}

/** The local calendar date `now` falls on, in a given zone. */
function todayIn(timeZone: string): Temporal.PlainDate {
  return Temporal.Now.zonedDateTimeISO(timeZone).toPlainDate();
}

interface Interval {
  start: number;
  end: number;
}

/** What is left of `base` once every span in `cuts` is removed. */
function subtract(base: Interval[], cuts: Interval[]): Interval[] {
  let remaining = base;

  for (const cut of cuts) {
    const next: Interval[] = [];

    for (const span of remaining) {
      if (cut.end <= span.start || cut.start >= span.end) {
        next.push(span);
        continue;
      }
      if (cut.start > span.start) {
        next.push({ start: span.start, end: cut.start });
      }
      if (cut.end < span.end) {
        next.push({ start: cut.end, end: span.end });
      }
    }

    remaining = next;
  }

  return remaining;
}

/* ---------------------------------------------------------------------------
   The seed
--------------------------------------------------------------------------- */

const { db, pool } = createDb(DATABASE_URL, 5);

interface Written {
  business: string;
  staff: number;
  services: number;
  timeOff: number;
  customers: number;
  appointments: number;
}

async function main() {
  const written: Written[] = [];

  for (const definition of BUSINESSES) {
    written.push(await seedBusiness(definition));
  }

  console.info("\n  Seeded the demo workspace.\n");

  for (const row of written) {
    console.info(
      `  ${row.business.padEnd(28)} ${row.staff} staff · ${row.services} services · ` +
        `${row.timeOff} closures · ${row.customers} customers · ${row.appointments} appointments`,
    );
  }

  console.info(
    `\n  Sign in at /demo, or with:\n` +
      `    ${SALON.name}: ${SALON.ownerEmail}\n` +
      `    ${CLINIC.name}: ${CLINIC.ownerEmail}\n` +
      `    password: the DEMO_OWNER_PASSWORD in your .env.local\n\n` +
      `  Public booking pages:\n` +
      BUSINESSES.map((one) => `    /book/${one.slug}`).join("\n") +
      "\n",
  );
}

async function seedBusiness(definition: SeedBusiness): Promise<Written> {
  return db.transaction(async (tx) => {
    /**
     * The demo triggers stood down for the length of this transaction.
     *
     * They exist to stop a visitor dismantling the demo (migration 0013), and
     * tearing the previous one down is precisely what this script has to do
     * first. `SET LOCAL` releases it on commit, so it can never leak onto a
     * pooled connection a request later picks up.
     */
    await tx.execute(sql`SET LOCAL openings.demo_bypass = 'on'`);

    /* ---- The owner ------------------------------------------------------ */

    /**
     * FOUND OR CREATED, and never duplicated: `users.email` is unique, and a
     * second run has to reuse the account rather than fail on it. The password
     * is rewritten every run, so changing DEMO_OWNER_PASSWORD and re-seeding
     * is all it takes.
     */
    const [owner] = await tx
      .insert(users)
      .values({
        id: `demo-owner-${definition.slug}`,
        name: definition.ownerName,
        email: definition.ownerEmail,
        /* TRUE, because there is no inbox to confirm from. Better Auth is
           configured to refuse sign-in until an address is verified, and a
           demo account nobody can sign into is not a demo. */
        emailVerified: true,
      })
      .onConflictDoUpdate({
        target: users.email,
        set: { name: definition.ownerName, emailVerified: true },
      })
      .returning({ id: users.id });

    const password = await hashPassword(DEMO_OWNER_PASSWORD);

    /**
     * The credential account, in the exact shape Better Auth's email-and-
     * password provider writes.
     *
     * `issuer` IS "local:credential" AND NOT "credential". Better Auth
     * recognises a returning identity by (issuer, account_id), and for the
     * built-in email-and-password provider the issuer is a SYNTHETIC LOCAL one
     * — the `local:` prefix is what separates it from a real OAuth issuer URL.
     * Getting it wrong does not fail loudly: the row inserts, the password
     * hash is fine, and sign-in simply answers 401 because the lookup matches
     * nothing. It is checked against a row written by the real sign-up form.
     *
     * The password is hashed with Better Auth's own hasher, so the sign-in
     * path verifies it with no special case anywhere in the application.
     */
    await tx
      .insert(accounts)
      .values({
        id: `demo-account-${definition.slug}`,
        issuer: CREDENTIAL_ISSUER,
        accountId: owner.id,
        providerId: "credential",
        userId: owner.id,
        password,
      })
      .onConflictDoUpdate({
        target: [accounts.issuer, accounts.accountId],
        set: { password, userId: owner.id },
      });

    /* ---- Tear the previous demo down ------------------------------------ */

    /**
     * DELETED, NOT UPDATED.
     *
     * Reconciling a live business row by row — which services still exist,
     * which staff were renamed, which appointments to keep — is a migration
     * engine, and writing one for scenery would be absurd. Everything cascades
     * from the business row, so one delete leaves nothing behind, and the
     * whole thing is rebuilt below. The transaction means a failure halfway
     * through leaves the old demo standing rather than no demo at all.
     */
    await tx.delete(businesses).where(eq(businesses.slug, definition.slug));

    /* ---- The business --------------------------------------------------- */

    const [business] = await tx
      .insert(businesses)
      .values({
        name: definition.name,
        slug: definition.slug,
        description: definition.description,
        address: definition.address,
        timezone: definition.timezone,
        currency: definition.currency,
        ownerUserId: owner.id,
        contactEmail: definition.contactEmail,
        contactPhone: definition.contactPhone,
        slotGranularityMin: definition.slotGranularityMin,
        minLeadTimeMin: definition.minLeadTimeMin,
        maxAdvanceDays: definition.maxAdvanceDays,
        cancellationWindowHours: definition.cancellationWindowHours,
        isDemo: true,
      })
      .returning();

    const timeZone = business.timezone;
    const today = todayIn(timeZone);

    /* ---- Services ------------------------------------------------------- */

    const serviceRows = await tx
      .insert(services)
      .values(
        definition.services.map((service, index) => ({
          businessId: business.id,
          name: service.name,
          description: service.description,
          durationMin: service.durationMin,
          bufferBeforeMin: service.bufferBeforeMin,
          bufferAfterMin: service.bufferAfterMin,
          priceCents: service.priceCents,
          depositType: service.depositType,
          depositValue: service.depositValue,
          displayOrder: index,
        })),
      )
      .returning();

    const serviceByKey = new Map(
      definition.services.map((service, index) => [
        service.key,
        serviceRows[index],
      ]),
    );

    /* ---- Staff, their hours, and who does what -------------------------- */

    const staffRows = await tx
      .insert(staff)
      .values(
        definition.staff.map((member, index) => ({
          businessId: business.id,
          name: member.name,
          email: member.email,
          initials: member.initials,
          displayOrder: index,
        })),
      )
      .returning();

    const staffByKey = new Map(
      definition.staff.map((member, index) => [member.key, staffRows[index]]),
    );

    /**
     * Hours are effective from a MONTH AGO, not from today.
     *
     * The demo shows a fortnight of history, and a rule that only started this
     * morning would leave every past day looking closed — the agenda would
     * draw appointments floating on a day with no opening hours behind them.
     */
    const effectiveFrom = today.subtract({ days: 45 }).toString();

    await tx.insert(availabilityRules).values(
      definition.staff.flatMap((member) =>
        member.hours.map((slot) => ({
          staffId: staffByKey.get(member.key)!.id,
          weekday: slot.weekday,
          startLocal: `${slot.startLocal}:00`,
          endLocal: `${slot.endLocal}:00`,
          effectiveFrom,
        })),
      ),
    );

    await tx.insert(serviceStaff).values(
      definition.staff.flatMap((member) =>
        member.serviceKeys.map((key) => ({
          serviceId: serviceByKey.get(key)!.id,
          staffId: staffByKey.get(member.key)!.id,
        })),
      ),
    );

    /* ---- Time off ------------------------------------------------------- */

    const closures = buildClosures(definition, today, timeZone, staffByKey);

    /* Not written to the database — see ProtectedWindow. The salon stays open
       across these; the generator simply does not fill them. */
    const protectedWindows = buildProtectedWindows(
      definition,
      today,
      timeZone,
      staffByKey,
    );

    if (closures.length > 0) {
      await tx.insert(timeOff).values(
        closures.map((closure) => ({
          businessId: business.id,
          staffId: closure.staffId,
          range: toTstzRangeLiteral(
            new Date(closure.start),
            new Date(closure.end),
          ),
          reason: closure.reason,
          isAllDay: closure.isAllDay,
        })),
      );
    }

    /* ---- Customers ------------------------------------------------------ */

    const customerRows = await tx
      .insert(customers)
      .values(
        definition.customerNames.map((name) => ({
          businessId: business.id,
          name,
          email: emailFor(name, definition.slug),
          phone: chance(0.7) ? phoneFor(definition) : null,
          /* Most people book from the business's own country; one or two do
             not, which is what makes the "we will show your time too" line in
             the confirmation email do something. */
          timezone: chance(0.15) ? pick(VISITING_ZONES) : timeZone,
        })),
      )
      .returning({ id: customers.id, name: customers.name });

    /* ---- The diary ------------------------------------------------------ */

    const planned = planAppointments({
      definition,
      timeZone,
      today,
      closures,
      protectedWindows,
      serviceByKey,
      staffByKey,
      customerIds: customerRows.map((row) => row.id),
    });

    if (planned.length > 0) {
      await tx.insert(appointments).values(
        planned.map((appointment) => ({
          businessId: business.id,
          ...appointment,
        })),
      );
    }

    return {
      business: definition.name,
      staff: staffRows.length,
      services: serviceRows.length,
      timeOff: closures.length,
      customers: customerRows.length,
      appointments: planned.length,
    };
  });
}

/** A handful of zones for the occasional visitor from somewhere else. */
const VISITING_ZONES = [
  "Europe/London",
  "America/New_York",
  "Europe/Berlin",
  "Australia/Sydney",
];

/** Deterministic, obviously fake, and unique within a business. */
function emailFor(name: string, slug: string): string {
  const handle = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]+/g, ".")
    .replace(/^\.|\.$/g, "");

  return `${handle}@${slug}.example`;
}

function phoneFor(definition: SeedBusiness): string {
  const prefix = definition.currency === "USD" ? "+1 312 555" : "+351 91 000";

  return `${prefix} ${String(1000 + randomInt(8999))}`;
}

/* ---------------------------------------------------------------------------
   Closures — including the awkward day
--------------------------------------------------------------------------- */

interface Closure {
  staffId: string | null;
  start: number;
  end: number;
  reason: string;
  isAllDay: boolean;
}

/**
 * A stretch the seed deliberately leaves EMPTY.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * The density walk is indifferent: it will happily fill Rosa's Tuesday morning
 * solid, and the first time it did, the awkward day stopped demonstrating
 * anything — the Balayage that is supposed to fit only in the morning fitted
 * nowhere at all, and the picker said "nothing free" instead of "before ten,
 * or not at all". A demo whose showpiece day is booked out is a demo of an
 * error message.
 *
 * So a few windows are protected. They are NOT time off — nothing is written
 * to the database for them, the hours still say the salon is open, and a
 * visitor can book straight into them. They are simply where the generator is
 * told not to put scenery.
 */
interface ProtectedWindow {
  /** Null protects the window for every staff member. */
  staffId: string | null;
  start: number;
  end: number;
}

/**
 * Time off, and one day built on purpose.
 *
 * ═══ THE AWKWARD DAY ═══
 *
 * Three days out, the salon has a lunch break, a blocked afternoon, and a
 * 150-minute service with 45 minutes of buffers around it. That is 195 minutes
 * of calendar for a Balayage, and the only stretch long enough is the morning —
 * so the public picker offers it before 10:00 and not at all after lunch, while
 * still offering 45-minute cuts in the hour between the break and the closure.
 *
 * It is here because it is the shape that catches a naive availability
 * implementation. A grid that offers every slot start would happily sell a
 * 14:30 Balayage into a one-hour gap; one that forgets buffers would sell 10:30
 * and run 15 minutes into the break. Neither is visible on an empty calendar,
 * and both are obvious on this one.
 */
function buildClosures(
  definition: SeedBusiness,
  today: Temporal.PlainDate,
  timeZone: string,
  staffByKey: Map<string, { id: string }>,
): Closure[] {
  const closures: Closure[] = [];

  const at = (date: Temporal.PlainDate, local: string) =>
    instantAt(date, timeZone, local);

  const allDay = (
    from: Temporal.PlainDate,
    days: number,
    reason: string,
    staffId: string | null,
  ): Closure => ({
    staffId,
    /* LOCAL DAY BOUNDARIES, resolved through the zone — not midnight UTC and
       not start-plus-24-hours. On the two days a local day is 23 or 25 hours
       long, only this is right. */
    start: from.toZonedDateTime(timeZone).startOfDay().epochMilliseconds,
    end: from
      .add({ days })
      .toZonedDateTime(timeZone)
      .startOfDay().epochMilliseconds,
    reason,
    isAllDay: true,
  });

  if (definition.slug === SALON.slug) {
    const awkward = today.add({ days: 3 });

    closures.push(
      {
        staffId: null,
        start: at(awkward, "13:00"),
        end: at(awkward, "14:00"),
        reason: "Lunch",
        isAllDay: false,
      },
      {
        staffId: null,
        start: at(awkward, "15:00"),
        end: at(awkward, "19:30"),
        reason: "Closed — colour training",
        isAllDay: false,
      },
      /* An ordinary personal afternoon off, somewhere else in the fortnight,
         so the agenda shows a lane closed while the others carry on. */
      {
        staffId: staffByKey.get("ines")!.id,
        start: at(today.add({ days: 8 }), "12:00"),
        end: at(today.add({ days: 8 }), "18:00"),
        reason: "Away from midday",
        isAllDay: false,
      },
      allDay(today.add({ days: 11 }), 1, "Public holiday — closed", null),
    );

    /* A lunch break on the past week's Wednesday too, so history has the same
       texture as the days ahead. */
    closures.push({
      staffId: null,
      start: at(today.subtract({ days: 5 }), "13:00"),
      end: at(today.subtract({ days: 5 }), "14:00"),
      reason: "Lunch",
      isAllDay: false,
    });
  }

  if (definition.slug === CLINIC.slug) {
    closures.push(
      /* Three days at a conference — an all-day closure spanning a weekend
         boundary, which is where a naive "start plus 72 hours" goes wrong. */
      allDay(
        today.add({ days: 6 }),
        3,
        "At the family medicine conference",
        staffByKey.get("marcus")!.id,
      ),
      {
        staffId: null,
        start: at(today.add({ days: 2 }), "12:00"),
        end: at(today.add({ days: 2 }), "13:00"),
        reason: "Practice meeting",
        isAllDay: false,
      },
      {
        staffId: staffByKey.get("priya")!.id,
        start: at(today.subtract({ days: 9 }), "07:30"),
        end: at(today.subtract({ days: 9 }), "13:00"),
        reason: "Sick",
        isAllDay: false,
      },
    );
  }

  return closures;
}

/**
 * The windows the generator must leave alone.
 *
 * ═══ THE AWKWARD DAY, FINISHED ═══
 *
 * Three days out the salon already has a lunch break and a blocked afternoon
 * (see `buildClosures`). This is the third ingredient: Rosa's morning is kept
 * clear, so the 150-minute Balayage — 195 minutes once its buffers are counted
 * — has exactly one stretch it fits in, and the picker offers it before ten
 * o'clock and nowhere else.
 *
 * Everything the day is meant to show is then true at once: a service too long
 * for the afternoon, a lunch break splitting what is left, a closure ending
 * the day early, and shorter services still bookable in the hour between the
 * two. Nothing about it is special-cased in the engine — it is the ordinary
 * algorithm meeting an ordinary Tuesday.
 */
function buildProtectedWindows(
  definition: SeedBusiness,
  today: Temporal.PlainDate,
  timeZone: string,
  staffByKey: Map<string, { id: string }>,
): ProtectedWindow[] {
  if (definition.slug !== SALON.slug) {
    return [];
  }

  const awkward = today.add({ days: 3 });

  return [
    {
      staffId: staffByKey.get("rosa")!.id,
      start: instantAt(awkward, timeZone, "09:00"),
      end: instantAt(awkward, timeZone, "13:00"),
    },
  ];
}

/* ---------------------------------------------------------------------------
   The diary
--------------------------------------------------------------------------- */

interface PlannedAppointment {
  staffId: string;
  serviceId: string;
  customerId: string;
  slot: string;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  priceCents: number;
  depositCents: number;
  icsUid: string;
  manageTokenHash: string;
  createdAt: Date;
  cancelledAt: Date | null;
  cancelledBy: "customer" | "business" | null;
  cancellationReason: string | null;
  customerNote: string | null;
}

/**
 * A fortnight either side of today, filled at a plausible density.
 *
 * ═══ WHY THIS WALKS A CURSOR INSTEAD OF PICKING RANDOM TIMES ═══
 *
 * `appointments_no_overlap` is a real exclusion constraint, and a seed that
 * scattered random start times would spend half its runs crashing on it. So
 * each staff member's day is walked in order: take their rostered hours,
 * subtract the closures, then step a cursor along whatever is left, either
 * placing an appointment (and jumping the cursor past its blocking range,
 * BUFFERS INCLUDED) or skipping one slot. Overlaps become impossible by
 * construction rather than by retrying — which is also what the availability
 * algorithm does, and the reason the two agree about what fits.
 */
function planAppointments(input: {
  definition: SeedBusiness;
  timeZone: string;
  today: Temporal.PlainDate;
  closures: Closure[];
  protectedWindows: ProtectedWindow[];
  serviceByKey: Map<string, { id: string; priceCents: number }>;
  staffByKey: Map<string, { id: string }>;
  customerIds: string[];
}): PlannedAppointment[] {
  const { definition, timeZone, today, closures } = input;
  const nowMs = Date.now();
  const planned: PlannedAppointment[] = [];

  for (const member of definition.staff) {
    const staffId = input.staffByKey.get(member.key)!.id;

    const performs = definition.services.filter((service) =>
      member.serviceKeys.includes(service.key),
    );

    for (let offset = -DAYS_BACK; offset <= DAYS_FORWARD; offset += 1) {
      const date = today.add({ days: offset });
      const weekday = date.dayOfWeek % 7;

      const shifts = member.hours
        .filter((slot) => slot.weekday === weekday)
        .map((slot) => ({
          start: instantAt(date, timeZone, slot.startLocal),
          end: instantAt(date, timeZone, slot.endLocal),
        }));

      if (shifts.length === 0) {
        continue;
      }

      /* Business-wide closures and this person's own, subtracted exactly as
         the availability engine subtracts them. */
      const cuts = [
        ...closures
          .filter(
            (closure) =>
              closure.staffId === null || closure.staffId === staffId,
          )
          .map((closure) => ({ start: closure.start, end: closure.end })),
        /* Left empty on purpose, and not written anywhere: the salon is open
           across these and a visitor can book them. See ProtectedWindow. */
        ...input.protectedWindows
          .filter(
            (window) => window.staffId === null || window.staffId === staffId,
          )
          .map((window) => ({ start: window.start, end: window.end })),
      ];

      for (const free of subtract(shifts, cuts)) {
        let cursor = free.start;

        while (cursor < free.end) {
          const service = pick(performs);
          const blocking =
            service.bufferBeforeMin +
            service.durationMin +
            service.bufferAfterMin;

          const fits = cursor + blocking * 60_000 <= free.end;

          if (!fits || !chance(BOOKING_DENSITY)) {
            /* Step by the grid, so what is left behind is a real opening on
               real boundaries rather than an odd four minutes. */
            cursor += definition.slotGranularityMin * 60_000;
            continue;
          }

          /* THE PRODUCT'S OWN RANGE BUILDER. Buffers land inside the stored
             `slot` here for the same reason they do in a real booking: the
             exclusion constraint is what enforces them, and it can only
             enforce what is in the range. */
          const range = buildBlockingRange(
            new Date(cursor + service.bufferBeforeMin * 60_000),
            service,
          );

          const icsUid = `${randomUUID()}@${SEED_ICS_DOMAIN}`;
          const startedMs = range.startsAt.getTime();
          const isPast = startedMs < nowMs;

          /**
           * DRAWN WHETHER OR NOT IT IS USED, and that is the whole point.
           *
           * The generator is deterministic, so every draw has to happen in the
           * same order on every run. Taking this one only for past
           * appointments would tie the sequence to the wall clock: an
           * appointment at four o'clock is "future" at noon and "past" at
           * five, so a run after lunch would consume one draw fewer and every
           * choice after it — services, customers, notes — would shift. Two
           * runs an hour apart must differ only in WHICH days are behind us.
           */
          const outcome = pick(PAST_STATUSES);

          const status: AppointmentStatus = isPast ? outcome : "confirmed";

          const deposit = depositFor(service);

          planned.push({
            staffId,
            serviceId: input.serviceByKey.get(service.key)!.id,
            customerId: pick(input.customerIds),
            slot: range.slot,
            startsAt: range.startsAt,
            endsAt: range.endsAt,
            status,
            priceCents: service.priceCents,
            depositCents: deposit,
            icsUid,
            /* Derived exactly as the product derives it, so the manage link
               printed on a seeded appointment is a link that works. */
            manageTokenHash: hashManageToken(deriveManageToken(icsUid)),
            /* Booked some days before the appointment, which is what makes the
               nightly tidy-up's "older than a day" rule meaningful and the
               customer list's "first booked" column believable. */
            createdAt: new Date(
              startedMs - (1 + randomInt(20)) * 24 * 60 * 60_000,
            ),
            cancelledAt:
              status === "cancelled"
                ? new Date(startedMs - 6 * 60 * 60_000)
                : null,
            cancelledBy: status === "cancelled" ? "customer" : null,
            cancellationReason: status === "cancelled" ? null : null,
            customerNote: chance(0.18) ? pick(CUSTOMER_NOTES) : null,
          });

          /* Past the blocking end, not the customer-facing end: the next
             appointment cannot start inside this one's cleanup time, and the
             constraint would refuse it if it tried. */
          cursor = range.blockingEnd.getTime();
        }
      }
    }
  }

  return planned;
}

/**
 * What a past appointment turned out to be.
 *
 * Weighted by repetition rather than by a probability table, so the shape is
 * obvious at a glance: mostly people turn up, occasionally they cancel, and
 * once in a while they simply do not arrive — which is the number the
 * customers screen counts and the reason it counts it.
 */
const PAST_STATUSES: AppointmentStatus[] = [
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "cancelled",
  "no_show",
];

const CUSTOMER_NOTES = [
  "Running five minutes late if the tram is bad.",
  "Same as last time, please.",
  "Parking nearby if possible.",
  "First time here — recommended by a friend.",
  "Please text rather than call.",
];

/** The same calculation `depositCentsFor` makes, on the seed's own shape. */
function depositFor(service: SeedService): number {
  switch (service.depositType) {
    case "none":
      return 0;
    case "flat":
      return Math.min(service.depositValue, service.priceCents);
    case "percent":
      return Math.min(
        Math.round((service.priceCents * service.depositValue) / 100),
        service.priceCents,
      );
  }
}

/* ---------------------------------------------------------------------------
   Run it
--------------------------------------------------------------------------- */

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("\n  The seed failed. Nothing was committed.\n", error);
    await pool.end().catch(() => {});
    process.exit(1);
  });
