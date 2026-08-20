"use client";

import { createAuthClient } from "better-auth/react";

import { clientEnv } from "@/env";

/**
 * The browser half of Better Auth.
 *
 * Only the four owner-facing forms use this — sign up, sign in, request a
 * reset, set a new password. Nothing in the customer booking flow imports it,
 * because customers never authenticate.
 *
 * Everything that decides what an owner may see or change is resolved on the
 * server through `@/lib/auth-server`. This module exists so a form can post
 * credentials and read back an error message, not so the client can hold an
 * opinion about who is signed in.
 */
export const authClient = createAuthClient({
  baseURL: clientEnv.NEXT_PUBLIC_APP_URL,
});

export const { signIn, signUp, signOut, requestPasswordReset, resetPassword } =
  authClient;
