import "server-only";

import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appointments,
  customers,
  services,
  staff,
  type AppointmentStatus,
} from "@/db/schema";

/**
 * Who has booked, and what happened when they did.
 *
 * ═══ THREE NUMBERS, AND EACH ONE IS A DECISION ═══
 *
 * SPEND counts `completed` appointments only. Money is what was earned, not
 * what was scheduled: a confirmed booking next Tuesday has not happened, and a
 * no-show earned nothing however much the price column says. Deposits already
 * taken on future bookings are real money, but they are not this customer's
 * spend yet — they are a liability until the appointment happens — so they are
 * excluded and the column is named for what it is.
 *
 * NO-SHOWS are counted because they are the one fact that changes how a
 * business treats a booking. Three of them is a reason to ask for a deposit,
 * and the number is useless if the owner has to count it by eye.
 *
 * VISITS count everything that was not a hold. A cancelled appointment is part
 * of somebody's history with the business, and hiding it would make a customer
 * who cancels every time look like a customer who has never been.
 *
 * ONE QUERY, aggregated in Postgres. Loading every appointment and counting in
 * JavaScript would be the whole diary over the wire to render a list of names.
 */

export interface CustomerRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  createdAt: string;
  /** Every appointment that was not merely a hold. */
  visits: number;
  noShows: number;
  /** Completed appointments only, in integer cents. */
  spendCents: number;
  /** ISO instant of the most recent appointment that has already happened. */
  lastVisitAt: string | null;
  /** ISO instant of the next confirmed one still to come. */
  nextVisitAt: string | null;
}

/**
 * The customer list, optionally narrowed by a search.
 *
 * The search is a case-insensitive substring across name, email and phone,
 * because an owner looking somebody up has whichever of the three the customer
 * just said down the phone. It is scoped to the business in the same WHERE
 * clause as the search itself, so a query can never widen past the tenant.
 */
export async function loadCustomers(
  businessId: string,
  query: string | null,
  limit = 200,
): Promise<CustomerRow[]> {
  const term = query?.trim();
  const like = term ? `%${term}%` : null;

  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      email: customers.email,
      phone: customers.phone,
      createdAt: customers.createdAt,
      visits: sql<number>`count(${appointments.id}) filter (
        where ${appointments.status} <> 'held'
      )::int`,
      noShows: sql<number>`count(${appointments.id}) filter (
        where ${appointments.status} = 'no_show'
      )::int`,
      spendCents: sql<number>`coalesce(sum(${appointments.priceCents}) filter (
        where ${appointments.status} = 'completed'
      ), 0)::int`,
      lastVisitAt: sql<string | null>`max(${appointments.startsAt}) filter (
        where ${appointments.startsAt} < now()
          and ${appointments.status} in ('confirmed', 'completed', 'no_show')
      )`,
      nextVisitAt: sql<string | null>`min(${appointments.startsAt}) filter (
        where ${appointments.startsAt} >= now()
          and ${appointments.status} = 'confirmed'
      )`,
    })
    .from(customers)
    .leftJoin(appointments, eq(appointments.customerId, customers.id))
    .where(
      and(
        eq(customers.businessId, businessId),
        like
          ? or(
              ilike(customers.name, like),
              ilike(customers.email, like),
              ilike(customers.phone, like),
            )
          : undefined,
      ),
    )
    .groupBy(customers.id)
    /* Whoever is coming soonest, then whoever came most recently, then
       alphabetically. An owner opening this screen is usually looking for
       somebody they are about to see or have just seen. */
    .orderBy(
      sql`min(${appointments.startsAt}) filter (
        where ${appointments.startsAt} >= now()
          and ${appointments.status} = 'confirmed'
      ) asc nulls last`,
      desc(sql`max(${appointments.startsAt})`),
      asc(customers.name),
    )
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    createdAt: row.createdAt.toISOString(),
    visits: row.visits,
    noShows: row.noShows,
    spendCents: row.spendCents,
    lastVisitAt: row.lastVisitAt
      ? new Date(row.lastVisitAt).toISOString()
      : null,
    nextVisitAt: row.nextVisitAt
      ? new Date(row.nextVisitAt).toISOString()
      : null,
  }));
}

export interface CustomerVisit {
  id: string;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  serviceName: string;
  staffName: string;
  priceCents: number;
  depositCents: number;
  internalNote: string | null;
}

/**
 * One customer's whole history, newest first.
 *
 * HOLDS ARE EXCLUDED. A hold is eight minutes of somebody deciding; it is not
 * a thing that happened to this customer, and a list peppered with abandoned
 * ones would bury the appointments that matter. (A hold has no customer
 * attached at all until it is claimed, so most of them could not appear here
 * anyway — this excludes the rest.)
 */
export async function loadCustomerHistory(
  businessId: string,
  customerId: string,
): Promise<CustomerVisit[]> {
  const rows = await db
    .select({
      id: appointments.id,
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      status: appointments.status,
      priceCents: appointments.priceCents,
      depositCents: appointments.depositCents,
      internalNote: appointments.internalNote,
      serviceName: services.name,
      staffName: staff.name,
    })
    .from(appointments)
    .innerJoin(services, eq(services.id, appointments.serviceId))
    .innerJoin(staff, eq(staff.id, appointments.staffId))
    .where(
      and(
        /* Both, and not just the customer id: the business scope is what stops
           an id from another tenant returning that tenant's diary. */
        eq(appointments.businessId, businessId),
        eq(appointments.customerId, customerId),
        sql`${appointments.status} <> 'held'`,
      ),
    )
    .orderBy(desc(appointments.startsAt))
    .limit(100);

  return rows.map((row) => ({
    id: row.id,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status,
    serviceName: row.serviceName,
    staffName: row.staffName,
    priceCents: row.priceCents,
    depositCents: row.depositCents,
    internalNote: row.internalNote,
  }));
}
