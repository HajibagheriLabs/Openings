import { SearchX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { PillButton } from "@/components/pill-button";

export const metadata: Metadata = {
  title: "Page not found",
};

/**
 * The application's 404.
 *
 * Renders inside the root layout, so it keeps the fonts, the theme and the
 * warm-grey canvas — Next's own default 404 is an unstyled black-on-white
 * document that looks like a different website, which is a worse thing to show
 * somebody than the mistyped address they arrived with.
 *
 * `/book/[slug]` keeps its own, more specific one: a stranger's booking link
 * that does not resolve deserves a sentence about links and businesses, not
 * about pages. See that file for why it does not distinguish "never existed"
 * from "removed".
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col items-start justify-center gap-5 px-5 py-16">
      <SearchX aria-hidden="true" className="size-6 text-ink-faint" />

      <h1 className="type-page-title text-ink">There is no page here</h1>

      <p className="type-body text-ink-muted">
        The address may have a typo in it, or the page may have moved. If you
        were on your way to book something, the link you want came from the
        business itself.
      </p>

      <PillButton asChild variant="secondary">
        <Link href="/">Go to the home page</Link>
      </PillButton>
    </main>
  );
}
