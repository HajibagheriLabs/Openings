"use server";

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { db } from "@/db";
import { UNIQUE_VIOLATION, isConstraintViolation } from "@/db/errors";
import {
  availabilityRules,
  businesses,
  serviceStaff,
  services,
  staff,
} from "@/db/schema";
import {
  BUSINESS_HINT_COOKIE,
  BUSINESS_HINT_MAX_AGE_SECONDS,
} from "@/lib/auth-cookies";
import { getOwnedBusiness, requireUser } from "@/lib/auth-server";
import { initialsFrom } from "@/lib/initials";
import { parseMoneyToCents } from "@/lib/money";
import { Temporal } from "@/lib/scheduling/temporal";
import { RESERVED_SLUGS, SLUG_PATTERN, slugify } from "@/lib/slug";
import {
  onboardingSchema,
  type OnboardingInput,
} from "@/lib/validation/onboarding";

/**
 * Onboarding: everything a business needs to take its first booking, created
 * in ONE transaction.
 *
 * The business, the owner's own staff row, that staff member's weekly hours,
 * the first service, and the link saying the owner can perform it either all
 * exist or none of them do. A half-created business is worse than no business
 * at all: it renders a booking page with opening hours and no service, or a
 * service nobody is allowed to perform, and the owner has no way to see which
 * piece is missing.
 */

export type OnboardingResult = {
  ok: false;
  /** Shown at the top of the step. */
  message: string;
  /** Which step to send the wizard back to. */
  step?: "business" | "hours" | "service";
  /** Field name, e.g. "slug", so the wizard can mark the input. */
  field?: string;
};

/**
 * Is this address free?
 *
 * Advisory only. Between this answer and the insert, someone else can take the
 * slug, so the transaction below does NOT trust it. The unique index is the
 * arbiter; this exists so the owner sees the problem while typing instead of
 * losing a filled-in form to a collision. Same shape as the booking flow: the
 * database decides, the application explains.
 */
export async function checkSlugAvailability(
  rawSlug: string,
): Promise<{ available: boolean; reason?: string }> {
  await requireUser();

  const slug = slugify(rawSlug);

  if (!slug || !SLUG_PATTERN.test(slug)) {
    return { available: false, reason: "Use letters, numbers and hyphens." };
  }

  if (RESERVED_SLUGS.has(slug)) {
    return { available: false, reason: "That address is reserved." };
  }

  const [existing] = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.slug, slug))
    .limit(1);

  return existing
    ? { available: false, reason: "That address is taken." }
    : { available: true };
}

/**
 * Creates the business. Returns only on failure — success ends in a redirect
 * to the admin area, so there is no "now what" state for the wizard to hold.
 */
export async function createBusiness(
  input: OnboardingInput,
): Promise<OnboardingResult> {
  const user = await requireUser();

  // Parsed again here. The wizard checks the same schema before it submits,
  // but a Server Action is a public HTTP endpoint and whatever the browser did
  // is a suggestion, not validation.
  const parsed = onboardingSchema.safeParse(input);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const [section, ...rest] = issue.path;

    return {
      ok: false,
      message: issue.message,
      step:
        section === "business"
          ? "business"
          : section === "hours"
            ? "hours"
            : "service",
      field: rest.join("."),
    };
  }

  const { business, hours, service } = parsed.data;

  // One owner, one business for now. A wizard re-submitted after its
  // transaction already committed — a double-clicked button, a retried
  // request — lands here and goes to the admin area instead of creating a
  // second business.
  const existing = await getOwnedBusiness(user.id);

  if (existing) {
    await writeBusinessHint(existing.slug);
    redirect("/admin");
  }

  // Non-null: the schema's superRefine already rejected anything unparseable,
  // and this runs on the parsed result.
  const priceCents = parseMoneyToCents(service.price)!;
  const depositValue =
    service.depositType === "flat"
      ? parseMoneyToCents(service.deposit)!
      : service.depositType === "percent"
        ? Number(service.deposit)
        : 0;

  /**
   * The day the hours start applying, as a LOCAL DATE in the business's own
   * timezone — not the server's, and not UTC. A business opening in Auckland
   * while the server runs on a UTC clock would otherwise get an
   * `effective_from` of yesterday, and its first day would quietly have no
   * hours at all.
   */
  const effectiveFrom = Temporal.Now.plainDateISO(business.timezone).toString();

  let slug: string;

  try {
    slug = await db.transaction(async (tx) => {
      const [createdBusiness] = await tx
        .insert(businesses)
        .values({
          name: business.name,
          slug: business.slug,
          timezone: business.timezone,
          currency: service.currency,
          ownerUserId: user.id,
          // The address the owner just verified. Editable in settings later.
          contactEmail: user.email,
        })
        .returning({ id: businesses.id, slug: businesses.slug });

      // The owner is the first bookable person. A one-person business is
      // complete as it stands; hiring later is adding a row, not changing the
      // model.
      const [createdStaff] = await tx
        .insert(staff)
        .values({
          businessId: createdBusiness.id,
          name: user.name,
          email: user.email,
          initials: initialsFrom(user.name),
          displayOrder: 0,
        })
        .returning({ id: staff.id });

      // Local wall-clock times, stored exactly as typed. Never instants — see
      // the note on availability_rules in the schema.
      const openDays = hours.filter((day) => day.isOpen);

      await tx.insert(availabilityRules).values(
        openDays.map((day) => ({
          staffId: createdStaff.id,
          weekday: day.weekday,
          startLocal: `${day.startLocal}:00`,
          endLocal: `${day.endLocal}:00`,
          effectiveFrom,
        })),
      );

      const [createdService] = await tx
        .insert(services)
        .values({
          businessId: createdBusiness.id,
          name: service.name,
          durationMin: service.durationMin,
          priceCents,
          depositType: service.depositType,
          depositValue,
          displayOrder: 0,
        })
        .returning({ id: services.id });

      // Without this link the availability algorithm has a service and a
      // person and no reason to believe one can do the other, so the brand new
      // booking page would offer nothing.
      await tx.insert(serviceStaff).values({
        serviceId: createdService.id,
        staffId: createdStaff.id,
      });

      return createdBusiness.slug;
    });
  } catch (error) {
    // The unique index is what actually decides the address is free, so this
    // is the real check. checkSlugAvailability above is only a courtesy.
    if (
      isConstraintViolation(error, UNIQUE_VIOLATION, "businesses_slug_unique")
    ) {
      return {
        ok: false,
        step: "business",
        field: "slug",
        message: "That address was just taken. Try another one.",
      };
    }

    throw error;
  }

  await writeBusinessHint(slug);

  // Outside the try on purpose: redirect() signals by throwing, and catching
  // it would turn a finished sign-up into a swallowed error.
  redirect("/admin");
}

/**
 * Writes the proxy's business hint. See src/lib/auth-cookies.ts — it is a
 * redirect shortcut, not a permission, and nothing reads it as authority.
 */
async function writeBusinessHint(slug: string): Promise<void> {
  const cookieStore = await cookies();

  cookieStore.set(BUSINESS_HINT_COOKIE, slug, {
    path: "/",
    sameSite: "lax",
    maxAge: BUSINESS_HINT_MAX_AGE_SECONDS,
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
  });
}
