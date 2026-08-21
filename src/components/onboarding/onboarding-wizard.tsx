"use client";

import { useState, useTransition } from "react";

import { FormError } from "@/components/field";
import { PillButton } from "@/components/pill-button";
import { ProgressLine } from "@/components/progress-line";
import { slugify } from "@/lib/slug";
import {
  DEFAULT_OPENING_HOURS,
  businessStepSchema,
  openingHoursSchema,
  serviceStepSchema,
} from "@/lib/validation/onboarding";
import { createBusiness } from "@/server/actions/onboarding";

import { BusinessStep } from "./business-step";
import { HoursStep } from "./hours-step";
import { ServiceStep } from "./service-step";
import {
  STEPS,
  type BusinessStepValue,
  type FieldErrors,
  type HoursStepValue,
  type ServiceStepValue,
  type StepName,
} from "./types";

/**
 * The three screens between signing up and taking bookings.
 *
 * State lives here and is submitted once. Nothing is written until the last
 * button, because the business, the owner's staff row, the weekly hours, the
 * first service and the link between them are created in a SINGLE database
 * transaction — a business that exists with no hours, or hours belonging to
 * nobody, is a worse outcome than a wizard that has to be filled in again.
 *
 * Each step is validated here before it advances so the owner hears about a
 * problem on the screen that caused it. The Server Action then validates the
 * whole thing again, because it is a public endpoint.
 */
export function OnboardingWizard({ ownerName }: { ownerName: string }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, startSubmitting] = useTransition();

  const [business, setBusiness] = useState<BusinessStepValue>({
    name: "",
    slug: "",
    // Filled from the browser after mount — see BusinessStep.
    timezone: "",
    timezoneConfirmed: false,
    slugEdited: false,
  });

  const [hours, setHours] = useState<HoursStepValue>(() =>
    DEFAULT_OPENING_HOURS.map((day) => ({ ...day })),
  );

  const [service, setService] = useState<ServiceStepValue>({
    name: "",
    durationMin: 60,
    currency: "EUR",
    price: "",
    depositType: "none",
    deposit: "0",
  });

  const step: StepName = STEPS[stepIndex];

  /** Zod issues to `{ field: message }`, first message per field wins. */
  function collect(issues: { path: PropertyKey[]; message: string }[]) {
    const collected: FieldErrors = {};

    for (const issue of issues) {
      // An issue with no path belongs to the step as a whole — "open on at
      // least one day", for instance.
      const key = issue.path.length > 0 ? String(issue.path[0]) : "root";
      collected[key] ??= issue.message;
    }

    return collected;
  }

  function validateStep(name: StepName): boolean {
    if (name === "business") {
      const result = businessStepSchema.safeParse({
        name: business.name,
        // A name typed but never blurred still needs a slug.
        slug: business.slug || slugify(business.name),
        timezone: business.timezone,
        timezoneConfirmed: business.timezoneConfirmed,
      });

      if (!result.success) {
        setErrors(collect(result.error.issues));
        return false;
      }

      // Keep the normalised slug the schema produced.
      setBusiness((current) => ({ ...current, slug: result.data.slug }));
    }

    if (name === "hours") {
      const result = openingHoursSchema.safeParse(hours);

      if (!result.success) {
        // Array issues are pathed by index; the grid is keyed by weekday.
        const collected: FieldErrors = {};

        for (const issue of result.error.issues) {
          if (typeof issue.path[0] === "number") {
            const day = hours[issue.path[0]];
            if (day) {
              collected[String(day.weekday)] ??= issue.message;
            }
          } else {
            collected.root ??= issue.message;
          }
        }

        setErrors(collected);
        return false;
      }
    }

    if (name === "service") {
      const result = serviceStepSchema.safeParse(service);

      if (!result.success) {
        setErrors(collect(result.error.issues));
        return false;
      }
    }

    setErrors({});
    return true;
  }

  function goNext() {
    setFormError(null);

    if (!validateStep(step)) {
      return;
    }

    setStepIndex((current) => Math.min(current + 1, STEPS.length - 1));
  }

  function goBack() {
    setFormError(null);
    setErrors({});
    setStepIndex((current) => Math.max(current - 1, 0));
  }

  function submit() {
    setFormError(null);

    if (!validateStep("service")) {
      return;
    }

    startSubmitting(async () => {
      // Returns only on failure: a successful create redirects to /admin.
      const result = await createBusiness({
        business: {
          name: business.name,
          slug: business.slug,
          timezone: business.timezone,
          timezoneConfirmed: true,
        },
        hours,
        service,
      });

      if (result?.ok === false) {
        setFormError(result.message);

        if (result.step) {
          setStepIndex(STEPS.indexOf(result.step));
        }

        setErrors(result.field ? { [result.field]: result.message } : {});
      }
    });
  }

  const isLastStep = stepIndex === STEPS.length - 1;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="type-label">
            Step {stepIndex + 1} of {STEPS.length}
          </p>
          <h1 className="type-page-title text-ink">
            Welcome, {ownerName.split(" ")[0]}
          </h1>
        </div>

        {/* A thin line, filled to the step. Never numbered circles. */}
        <ProgressLine
          step={stepIndex + 1}
          total={STEPS.length}
          label="Setup progress"
        />
      </header>

      <FormError>{formError}</FormError>

      {step === "business" ? (
        <BusinessStep
          value={business}
          errors={errors}
          onChange={setBusiness}
        />
      ) : null}

      {step === "hours" ? (
        <HoursStep
          value={hours}
          errors={errors}
          timezone={business.timezone}
          onChange={setHours}
        />
      ) : null}

      {step === "service" ? (
        <ServiceStep value={service} errors={errors} onChange={setService} />
      ) : null}

      <div className="flex items-center gap-3">
        {stepIndex > 0 ? (
          <PillButton
            type="button"
            variant="secondary"
            onClick={goBack}
            disabled={submitting}
          >
            Back
          </PillButton>
        ) : null}

        <PillButton
          type="button"
          onClick={isLastStep ? submit : goNext}
          disabled={submitting}
          className="flex-1"
        >
          {isLastStep
            ? submitting
              ? "Creating your business…"
              : "Create my business"
            : "Continue"}
        </PillButton>
      </div>
    </div>
  );
}
