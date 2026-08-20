import type { Metadata } from "next";

import { SignUpForm } from "@/components/auth/sign-up-form";

export const metadata: Metadata = {
  title: "Set up your business",
};

export default function SignUpPage() {
  return <SignUpForm />;
}
