import type { Metadata } from "next";

import { SignInForm } from "@/components/auth/sign-in-form";

export const metadata: Metadata = {
  title: "Sign in",
};

/**
 * `next` is where the proxy wanted to send them before it found no session.
 * It is validated in the form before it is followed — a query parameter is
 * attacker-controlled, and an unchecked redirect target is an open redirect.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return <SignInForm next={next} />;
}
