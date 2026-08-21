"use client";

import Link from "next/link";
import { useState } from "react";

import { Field, FormError } from "@/components/field";
import { PillButton } from "@/components/pill-button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { forgotPasswordSchema } from "@/lib/validation/auth";

/**
 * Request a reset link.
 *
 * The answer is the same whether or not the address has an account. Saying
 * "no account with that email" would turn this form into a way to test which
 * addresses are registered — and that list, for a booking product, is a list
 * of local businesses worth phishing.
 */
export function ForgotPasswordForm() {
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const parsed = forgotPasswordSchema.safeParse({ email: form.get("email") });

    if (!parsed.success) {
      setFieldError(parsed.error.issues[0].message);
      return;
    }

    setFieldError(null);
    setFormError(null);
    setPending(true);

    const { error } = await authClient.requestPasswordReset({
      email: parsed.data.email,
      // Where the link in the email lands. Better Auth appends the one-time
      // token as a query parameter.
      redirectTo: "/reset-password",
    });

    setPending(false);

    if (error) {
      setFormError("Could not send the link right now. Try again in a moment.");
      return;
    }

    setDone(true);
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="type-page-title text-ink">Check your email</h1>
        <p className="type-body text-ink-muted">
          If that address has an account, a link to choose a new password is on
          its way. It works once and expires in an hour.
        </p>
        <Link
          href="/sign-in"
          className="type-section w-fit rounded-pill text-accent underline-offset-4 hover:underline"
        >
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h1 className="type-page-title text-ink">Forgot your password</h1>
        <p className="type-body text-ink-muted">
          Tell us the address you signed up with and we will send a link to
          choose a new one.
        </p>
      </div>

      <FormError>{formError}</FormError>

      <Field id="email" label="Email" error={fieldError}>
        {(props) => (
          <Input
            {...props}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoFocus
            required
          />
        )}
      </Field>

      <PillButton
        type="submit"
        disabled={pending}
        block
      >
        {pending ? "Sending…" : "Send the link"}
      </PillButton>

      <Link
        href="/sign-in"
        className="type-body-sm w-fit rounded-pill text-accent underline-offset-4 hover:underline"
      >
        Back to sign in
      </Link>
    </form>
  );
}
