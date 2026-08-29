"use client";

import { useEffect } from "react";

/**
 * The last boundary. It catches a failure in the ROOT LAYOUT itself.
 *
 * ═══ IT REPLACES THE WHOLE DOCUMENT, SO IT DEPENDS ON NOTHING ═══
 *
 * When this renders, the root layout did not — which means no `<html>`, no
 * `<body>`, no font variables, no ThemeProvider and no guarantee that
 * globals.css was ever applied. So it brings its own everything: its own
 * document tags, and the six Daybook values it needs written out longhand in a
 * `<style>` block.
 *
 * That duplication is deliberate and is the only place in the application
 * where a colour is repeated outside globals.css. A boundary that imports the
 * design system to draw itself is a boundary that goes blank the day the
 * design system is what broke. The values are the palette's own hexes.
 *
 * DARK MODE COMES FROM `prefers-color-scheme`, NOT FROM next-themes. The
 * provider that reads the stored preference is part of the tree that just
 * failed. The operating system's answer is the honest fallback, and it is
 * right for almost everybody.
 *
 * `lang="en"` and a real `<title>` are here for the same reason: this page is
 * a whole document, and a document with neither is one a screen reader cannot
 * announce.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <head>
        <title>Something went wrong · Openings</title>
        <style>{CSS}</style>
      </head>
      <body>
        <main>
          <p className="label">Openings</p>

          <h1>The page could not be drawn</h1>

          <p className="body">
            Something failed before the page was built, so none of it loaded.
            Nothing you were doing has been saved or charged. Reload and it will
            almost certainly come back.
          </p>

          <div className="actions">
            <button type="button" onClick={reset}>
              Reload the page
            </button>

            {/* A plain anchor, and it has to be. `next/link` does a
                client-side navigation through a router that is part of the
                tree that just failed; a full document load is the only way out
                of here that is guaranteed to work. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/">Go to the home page</a>
          </div>

          {error.digest ? (
            <p className="digest">
              If you get in touch about this, quote {error.digest}.
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}

/**
 * Daybook, longhand. Warm-grey canvas, white surface, one verdigris accent,
 * and a system font stack because Epilogue and Hanken Grotesk are loaded by
 * the layout that is missing.
 */
const CSS = `
  :root {
    --canvas: #EFEDE9;
    --surface: #FFFFFF;
    --line: #DAD6D0;
    --ink: #1A1B19;
    --ink-muted: #5F615C;
    --ink-faint: #8E918B;
    --accent: #14655C;
    --accent-contrast: #FFFFFF;
    color-scheme: light dark;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --canvas: #17171A;
      --surface: #1E1F22;
      --line: rgba(240, 238, 232, 0.10);
      --ink: #EDEBE6;
      --ink-muted: #A0A29C;
      --ink-faint: #74766F;
      --accent: #46A79A;
    }
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--canvas);
    color: var(--ink);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 15px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }

  main {
    max-width: 560px;
    margin: 0 auto;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 16px;
    padding: 48px 20px;
  }

  .label {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }

  h1 {
    margin: 0;
    font-size: 22px;
    line-height: 1.25;
    font-weight: 600;
  }

  .body {
    margin: 0;
    max-width: 60ch;
    color: var(--ink-muted);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-top: 8px;
  }

  /* 44px targets and 999px radius, the same as every other control here. */
  button, .actions a {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 44px;
    padding: 0 20px;
    border-radius: 999px;
    font: inherit;
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
  }

  button {
    border: 0;
    background: var(--accent);
    color: var(--accent-contrast);
  }

  .actions a {
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--ink);
  }

  /* Focus is never removed. */
  :focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .digest {
    margin: 0;
    font-size: 13.5px;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
  }
`;
