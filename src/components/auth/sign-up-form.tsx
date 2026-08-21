"use client";

import Link from "next/link";
import { useState } from "react";

import { Field, FormError } from "@/components/field";
import { PillButton } from "@/components/pill-button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { PASSWORD_MIN_LENGTH, signUpSchema } from "@/lib/validation/auth";

/**
 * Owner sign-up.
 *
 * No session is created here. `requireEmailVerification` is on, so the account
 * exists but cannot sign in until the address is confirmed — which is why this
 * form ends on a "check your email" panel rather than a redirect.
 */
export function SignUpForm() {
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const parsed = signUpSchema.safeParse({
      name: form.get("name"),
      email: form.get("email"),
      password: form.get("password"),
    });

    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0]);
        errors[key] ??= issue.message;
      }
      setFieldErrors(errors);
      setFormError(null);
      return;
    }

    setFieldErrors({});
    setFormError(null);
    setPending(true);

    const { error } = await authClient.signUp.email({
      name: parsed.data.name,
      email: parsed.data.email,
      password: parsed.data.password,
      // Where the verification link lands once it is followed. Straight into
      // setting the business up — there is nothing else to do first.
      callbackURL: "/onboarding",
    });

    setPending(false);

    if (error) {
      setFormError(
        error.code === "USER_ALREADY_EXISTS"
          ? "There is already an account with that address. Sign in instead."
          : (error.message ??
            "Something went wrong creating the account. Try again."),
      );
      return;
    }

    setSentTo(parsed.data.email);
  }

  if (sentTo) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="type-page-title text-ink">Check your email</h1>
        <p className="type-body text-ink-muted">
          We sent a confirmation link to <strong>{sentTo}</strong>. Follow it and
          you can set your business up.
        </p>
        <p className="type-body-sm text-ink-faint">
          Nothing arrived? Look in spam, then try signing in — we will send a
          fresh link.
        </p>
        <Link
          href="/sign-in"
          className="type-section w-fit rounded-pill text-accent underline-offset-4 hover:underline"
        >
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h1 className="type-page-title text-ink">Set up your business</h1>
        <p className="type-body text-ink-muted">
          Takes about two minutes. You will need your opening hours and one
          service to start with.
        </p>
      </div>

      <FormError>{formError}</FormError>

      <Field id="name" label="Your name" error={fieldErrors.name}>
        {(props) => (
          <Input
            {...props}
            name="name"
            autoComplete="name"
            autoFocus
            required
          />
        )}
      </Field>

      <Field id="email" label="Email" error={fieldErrors.email}>
        {(props) => (
          <Input
            {...props}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
          />
        )}
      </Field>

      <Field
        id="password"
        label="Password"
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        error={fieldErrors.password}
      >
        {(props) => (
          <Input
            {...props}
            name="password"
            type="password"
            autoComplete="new-password"
            required
          />
        )}
      </Field>

      <PillButton
        type="submit"
        disabled={pending}
        block
      >
        {pending ? "Creating your account…" : "Create account"}
      </PillButton>

      <p className="type-body-sm text-ink-muted">
        Already have an account?{" "}
        <Link
          href="/sign-in"
          className="rounded-pill text-accent underline-offset-4 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </form>
  );
}
