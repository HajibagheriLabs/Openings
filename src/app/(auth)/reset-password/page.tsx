import type { Metadata } from "next";
import Link from "next/link";

import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export const metadata: Metadata = {
  title: "Choose a new password",
};

/**
 * Better Auth's reset link goes through /api/auth/reset-password/:token, which
 * validates the token and forwards here with `?token=…`. If it was already
 * used, expired, or tampered with, it forwards with `?error=…` and no token —
 * so a missing token is a real state to render, not an accident.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="type-page-title text-ink">That link no longer works</h1>
        <p className="type-body text-ink-muted">
          Reset links work once and expire after an hour. Ask for a new one and
          it will arrive in a moment.
        </p>
        <Link
          href="/forgot-password"
          className="type-section w-fit rounded-pill text-accent underline-offset-4 hover:underline"
        >
          Send me a new link
        </Link>
      </div>
    );
  }

  return <ResetPasswordForm token={token} />;
}
