import Link from "next/link";
import type { ReactNode } from "react";

import { APP_NAME } from "@/lib/brand";

/**
 * The shell around the four owner account pages.
 *
 * One column, centred, on the warm-grey canvas, with the form on a white
 * --surface panel and nothing else competing for attention. These pages are
 * the only part of the product a customer never sees.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <main className="mx-auto flex w-full max-w-[440px] flex-1 flex-col justify-center gap-6 px-5 py-12">
        <Link
          href="/"
          className="type-label w-fit rounded-pill transition-colors hover:text-ink-muted"
        >
          {APP_NAME}
        </Link>

        <div className="rounded-card border border-line bg-surface p-6 sm:p-8">
          {children}
        </div>

        <p className="type-body-sm text-center text-ink-faint">
          Accounts are for businesses that take bookings. Customers book as
          guests — no account, no password.
        </p>
      </main>
    </div>
  );
}
