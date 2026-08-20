"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Field, FormError } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { signInSchema } from "@/lib/validation/auth";

/**
 * Owner sign-in.
 *
 * The unverified-address case gets its own branch instead of a generic error,
 * because it is the one failure the person can actually fix — and the fix is a
 * fresh link, not a different password.
 */
export function SignInForm({ next }: { next?: string }) {
  const router = useRouter();

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">(
    "idle",
  );
  const [pending, setPending] = useState(false);

  /**
   * Only same-origin paths. `next` arrives in the query string, where anyone
   * can put anything, and following it blindly would turn the sign-in page
   * into an open redirect.
   */
  const destination =
    next && next.startsWith("/") && !next.startsWith("//") ? next : "/admin";

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const parsed = signInSchema.safeParse({
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
    setUnverifiedEmail(null);
    setPending(true);

    const { error } = await authClient.signIn.email({
      email: parsed.data.email,
      password: parsed.data.password,
    });

    setPending(false);

    if (error) {
      if (error.code === "EMAIL_NOT_VERIFIED") {
        setUnverifiedEmail(parsed.data.email);
        return;
      }

      setFormError(
        error.code === "INVALID_EMAIL_OR_PASSWORD"
          ? "That email and password do not match an account."
          : (error.message ?? "Could not sign you in. Try again."),
      );
      return;
    }

    router.push(destination);
    // The admin area is a Server Component tree; without this it can be served
    // from the client router cache as it looked while signed out.
    router.refresh();
  }

  async function resendVerification() {
    if (!unverifiedEmail) {
      return;
    }

    setResendState("sending");

    await authClient.sendVerificationEmail({
      email: unverifiedEmail,
      callbackURL: "/onboarding",
    });

    setResendState("sent");
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h1 className="type-page-title text-ink">Sign in</h1>
        <p className="type-body text-ink-muted">
          For the people who run a business. Customers do not need an account.
        </p>
      </div>

      <FormError>{formError}</FormError>

      {unverifiedEmail ? (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-card border border-pending/40 bg-pending/10 px-4 py-3"
        >
          <p className="type-body-sm text-pending">
            Confirm your email first. We sent a link to {unverifiedEmail} when
            the account was created.
          </p>
          {resendState === "sent" ? (
            <p className="type-body-sm text-pending">
              A fresh link is on its way.
            </p>
          ) : (
            <button
              type="button"
              onClick={resendVerification}
              disabled={resendState === "sending"}
              className="type-body-sm rounded-pill text-pending underline underline-offset-4 disabled:opacity-60"
            >
              {resendState === "sending"
                ? "Sending…"
                : "Send me another link"}
            </button>
          )}
        </div>
      ) : null}

      <Field id="email" label="Email" error={fieldErrors.email}>
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

      <Field id="password" label="Password" error={fieldErrors.password}>
        {(props) => (
          <Input
            {...props}
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        )}
      </Field>

      <Button
        type="submit"
        disabled={pending}
        className="type-section h-11 w-full rounded-pill"
      >
        {pending ? "Signing in…" : "Sign in"}
      </Button>

      <div className="flex flex-col gap-2">
        <Link
          href="/forgot-password"
          className="type-body-sm w-fit rounded-pill text-accent underline-offset-4 hover:underline"
        >
          I forgot my password
        </Link>
        <p className="type-body-sm text-ink-muted">
          No account yet?{" "}
          <Link
            href="/sign-up"
            className="rounded-pill text-accent underline-offset-4 hover:underline"
          >
            Set up your business
          </Link>
        </p>
      </div>
    </form>
  );
}
