"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Field, FormError } from "@/components/field";
import { PillButton } from "@/components/pill-button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { PASSWORD_MIN_LENGTH, resetPasswordSchema } from "@/lib/validation/auth";

/**
 * Choose a new password.
 *
 * The token comes from the link in the email, read on the server and handed
 * down as a prop. Resetting also revokes the account's other sessions
 * (`revokeSessionsOnPasswordReset`), because "I need a new password" usually
 * means "someone else may have the old one".
 */
export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();

  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const confirmation = String(form.get("confirmation") ?? "");

    const parsed = resetPasswordSchema.safeParse({ password });

    if (!parsed.success) {
      setFieldError(parsed.error.issues[0].message);
      return;
    }

    if (password !== confirmation) {
      setFieldError(null);
      setFormError("The two passwords do not match.");
      return;
    }

    setFieldError(null);
    setFormError(null);
    setPending(true);

    const { error } = await authClient.resetPassword({
      newPassword: parsed.data.password,
      token,
    });

    setPending(false);

    if (error) {
      setFormError(
        error.code === "INVALID_TOKEN" || error.code === "TOKEN_EXPIRED"
          ? "That link has expired or was already used. Ask for a new one."
          : (error.message ?? "Could not change the password. Try again."),
      );
      return;
    }

    setDone(true);
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="type-page-title text-ink">Password changed</h1>
        <p className="type-body text-ink-muted">
          Any other browser that was signed in has been signed out.
        </p>
        <PillButton
          type="button"
          onClick={() => router.push("/sign-in")}
          block
        >
          Sign in
        </PillButton>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h1 className="type-page-title text-ink">Choose a new password</h1>
        <p className="type-body text-ink-muted">
          Pick something you have not used here before.
        </p>
      </div>

      <FormError>{formError}</FormError>

      <Field
        id="password"
        label="New password"
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        error={fieldError}
      >
        {(props) => (
          <Input
            {...props}
            name="password"
            type="password"
            autoComplete="new-password"
            autoFocus
            required
          />
        )}
      </Field>

      <Field id="confirmation" label="New password again">
        {(props) => (
          <Input
            {...props}
            name="confirmation"
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
        {pending ? "Saving…" : "Save the new password"}
      </PillButton>

      <Link
        href="/forgot-password"
        className="type-body-sm w-fit rounded-pill text-accent underline-offset-4 hover:underline"
      >
        Send me a new link
      </Link>
    </form>
  );
}
