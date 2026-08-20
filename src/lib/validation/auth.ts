import { z } from "zod";

/**
 * The owner sign-in contract, shared by the forms and by the Better Auth
 * configuration. Nothing here is customer-facing: customers book as guests and
 * never see a password field.
 */

/**
 * Ten, not the usual eight.
 *
 * `src/lib/auth.ts` passes this same number to Better Auth, so the rule the
 * form shows and the rule the server enforces cannot drift apart.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("That does not look like an email address."));

const passwordSchema = z
  .string()
  .min(
    PASSWORD_MIN_LENGTH,
    `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
  )
  .max(PASSWORD_MAX_LENGTH, "That password is too long.");

export const signUpSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Tell us your name.")
    .max(80, "That name is too long."),
  email: emailSchema,
  password: passwordSchema,
});

export const signInSchema = z.object({
  email: emailSchema,
  // Not length-checked: an existing password predates any rule we tighten
  // later, and telling someone their real password is "too short" at the sign
  // in form is both wrong and confusing.
  password: z.string().min(1, "Enter your password."),
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const resetPasswordSchema = z.object({
  password: passwordSchema,
});

export type SignUpInput = z.input<typeof signUpSchema>;
export type SignInInput = z.input<typeof signInSchema>;
export type ForgotPasswordInput = z.input<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.input<typeof resetPasswordSchema>;
