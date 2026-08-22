import { SearchX } from "lucide-react";
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "No booking page here",
};

/**
 * A real 404 for a slug that belongs to nobody.
 *
 * Says what happened and what to do, and nothing else. No search box across
 * other businesses, no list of suggestions, no redirect somewhere more
 * "helpful" — a mistyped address is a mistyped address, and quietly sending
 * somebody to a different salon's booking page would be worse than useless.
 *
 * It also does not distinguish a slug that never existed from one that was
 * renamed or removed. From outside they are the same fact, and being precise
 * about which would tell strangers what this database contains.
 */
export default function BookingNotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col items-start justify-center gap-5 px-5 py-16">
      <SearchX aria-hidden="true" className="size-6 text-ink-faint" />

      <h1 className="type-page-title text-ink">No booking page at this address</h1>

      <p className="type-body text-ink-muted">
        The link may have a typo in it, or the business may have changed its
        booking address. Check the link you were sent, or ask them for the
        current one.
      </p>

      <Link
        href="/"
        className="type-section rounded-pill text-accent underline-offset-4 hover:underline"
      >
        Go to the home page
      </Link>
    </main>
  );
}
