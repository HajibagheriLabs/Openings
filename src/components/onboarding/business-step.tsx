"use client";

import { useEffect, useState, useTransition } from "react";

import { Field } from "@/components/field";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { slugify } from "@/lib/slug";
import { SUPPORTED_TIMEZONES } from "@/lib/validation/onboarding";
import { checkSlugAvailability } from "@/server/actions/onboarding";

import type { BusinessStepValue, FieldErrors } from "./types";

/**
 * Step 1 — who the business is, where it lives, and what time it is there.
 *
 * The timezone is the consequential field on this screen and the copy says so.
 * Every instant the product ever computes — the hours a customer is offered,
 * the lead-time cutoff, when the reminder fires — is resolved on the server in
 * this zone. It is defaulted from the browser and then explicitly confirmed,
 * because getting it wrong throws no error: it just quietly offers the wrong
 * hours to everybody, forever.
 */
export function BusinessStep({
  value,
  errors,
  onChange,
}: {
  value: BusinessStepValue;
  errors: FieldErrors;
  onChange: (next: BusinessStepValue) => void;
}) {
  const [slugStatus, setSlugStatus] = useState<
    { state: "idle" } | { state: "free" } | { state: "taken"; reason: string }
  >({ state: "idle" });
  const [checking, startChecking] = useTransition();

  /**
   * The browser's own zone, read after mount rather than during render. On the
   * server this call would return the SERVER's timezone, and the two would
   * disagree at hydration.
   */
  useEffect(() => {
    if (value.timezone) {
      return;
    }

    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;

    onChange({
      ...value,
      timezone: SUPPORTED_TIMEZONES.includes(detected) ? detected : "",
    });
    // Runs once, to fill an empty field. Re-running on every keystroke
    // elsewhere in the step would fight the owner for control of the select.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setName(name: string) {
    onChange({
      ...value,
      name,
      slug: value.slugEdited ? value.slug : slugify(name),
    });
  }

  function setSlug(slug: string) {
    setSlugStatus({ state: "idle" });
    onChange({ ...value, slug: slug.toLowerCase(), slugEdited: true });
  }

  /**
   * Advisory. The unique index in the database is what actually decides, and
   * the Server Action turns its violation into the same sentence — this only
   * moves the news earlier.
   */
  function verifySlug() {
    const slug = value.slug.trim();

    if (!slug) {
      return;
    }

    startChecking(async () => {
      const result = await checkSlugAvailability(slug);

      setSlugStatus(
        result.available
          ? { state: "free" }
          : { state: "taken", reason: result.reason ?? "Not available." },
      );
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="type-page-title text-ink">Your business</h2>
        <p className="type-body text-ink-muted">
          The name customers will see, and the address they will book at.
        </p>
      </div>

      <Field id="business-name" label="Business name" error={errors.name}>
        {(props) => (
          <Input
            {...props}
            value={value.name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Rosa's Hair Studio"
            autoComplete="organization"
            autoFocus
          />
        )}
      </Field>

      <Field
        id="business-slug"
        label="Booking address"
        hint={
          slugStatus.state === "free"
            ? "That address is free."
            : "Customers will book at this address. You can change it now; changing it later breaks links you have shared."
        }
        error={
          errors.slug ??
          (slugStatus.state === "taken" ? slugStatus.reason : undefined)
        }
      >
        {(props) => (
          <div className="flex items-center gap-2">
            <span className="type-body-sm shrink-0 text-ink-faint">/book/</span>
            <Input
              {...props}
              value={value.slug}
              onChange={(event) => setSlug(event.target.value)}
              onBlur={verifySlug}
              placeholder="rosas-hair-studio"
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
            />
            {checking ? (
              <span className="type-body-sm shrink-0 text-ink-faint">
                Checking…
              </span>
            ) : null}
          </div>
        )}
      </Field>

      <Field
        id="business-timezone"
        label="Timezone"
        hint="Every time in the product is worked out in this zone: the hours a customer is offered, when a reminder goes out, what tomorrow means. Get it right now and nothing else has to think about it."
        error={errors.timezone}
      >
        {(props) => (
          <SelectNative
            {...props}
            value={value.timezone}
            onChange={(event) =>
              onChange({
                ...value,
                timezone: event.target.value,
                // A changed zone has not been confirmed yet.
                timezoneConfirmed: false,
              })
            }
          >
            <option value="" disabled>
              Choose a timezone
            </option>
            {SUPPORTED_TIMEZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone.replace(/_/g, " ")}
              </option>
            ))}
          </SelectNative>
        )}
      </Field>

      <div className="flex flex-col gap-2">
        <label className="flex cursor-pointer items-start gap-3">
          <Checkbox
            checked={value.timezoneConfirmed === true}
            onCheckedChange={(checked) =>
              onChange({ ...value, timezoneConfirmed: checked === true })
            }
            className="mt-1"
          />
          <span className="type-body text-ink">
            {value.timezone
              ? `Yes — this business runs on ${value.timezone.replace(/_/g, " ")} time.`
              : "Yes — that is the timezone this business runs on."}
          </span>
        </label>

        {errors.timezoneConfirmed ? (
          <p className="type-body-sm text-cancelled">
            {errors.timezoneConfirmed}
          </p>
        ) : null}
      </div>
    </div>
  );
}
