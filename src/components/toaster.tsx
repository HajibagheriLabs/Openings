"use client";

import { useTheme } from "next-themes";
import { Toaster as SonnerToaster } from "sonner";

/**
 * The owner area's toasts.
 *
 * Mounted once in the admin layout. Toasts are CHROME, which is the only place
 * the system-state colours are allowed — the same rule as the status badges,
 * and the reason none of this palette may touch the ribbon.
 *
 * Sonner is themed through its CSS variables rather than a rewritten
 * stylesheet, so it keeps its own positioning, stacking and swipe-to-dismiss
 * while every colour it paints comes from the Daybook tokens and flips with
 * the theme.
 */
export function Toaster() {
  const { resolvedTheme } = useTheme();

  return (
    <SonnerToaster
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      position="bottom-center"
      // A toast that floats gets the float shadow — the same token as dialogs
      // and sheets, and one of only two shadows in the product.
      toastOptions={{
        classNames: {
          toast: "rounded-card border border-line shadow-float",
          title: "type-section",
          description: "type-body-sm",
          actionButton: "rounded-pill",
          cancelButton: "rounded-pill",
        },
        style: {
          background: "var(--surface)",
          color: "var(--ink)",
          borderColor: "var(--line)",
        },
      }}
      style={
        {
          "--normal-bg": "var(--surface)",
          "--normal-text": "var(--ink)",
          "--normal-border": "var(--line)",
          "--success-bg": "var(--surface)",
          "--success-text": "var(--confirmed)",
          "--success-border": "var(--line)",
          "--error-bg": "var(--surface)",
          "--error-text": "var(--cancelled)",
          "--error-border": "var(--line)",
        } as React.CSSProperties
      }
    />
  );
}
