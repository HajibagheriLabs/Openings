import { APP_NAME } from "@/lib/brand";

/**
 * Placeholder home page.
 *
 * Its only job right now is to prove the design system is wired up: both type
 * faces, both shadow tokens, and slot states encoded by fill, pattern and
 * value rather than by hue. The real Ribbon component replaces this and is
 * shared by the customer day picker and the admin agenda.
 *
 * The times below are literal strings because nothing here is real data yet.
 * In the product, the server sends ISO instants plus the business timezone and
 * the client formats them with Intl.DateTimeFormat — it never does date
 * arithmetic.
 */

/** Fixed scale. A 90-minute service occupies three times a 30-minute one. */
const PX_PER_MIN = 1.4;

const DAY_START_MIN = 9 * 60;
const DAY_END_MIN = 14 * 60;

const minutesFromStart = (min: number) => min - DAY_START_MIN;
const top = (min: number) => `${minutesFromStart(min) * PX_PER_MIN}px`;
const height = (mins: number) => `${mins * PX_PER_MIN}px`;

const HOURS = [9, 10, 11, 12, 13, 14];

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col gap-8 px-5 py-12">
      <header className="flex flex-col gap-3">
        <p className="type-label">{APP_NAME}</p>
        <h1 className="type-display text-ink">Pick a time.</h1>
        <p className="type-body text-ink-muted">
          Time is drawn to scale. A longer service takes up more of the day, and
          a booked appointment is carved out of it rather than stacked on top.
        </p>
      </header>

      <section aria-labelledby="ribbon-heading" className="flex flex-col gap-4">
        <h2 id="ribbon-heading" className="type-section text-ink">
          Thursday, 20 August
        </h2>

        <div className="flex gap-3">
          {/* Time axis. Every time in the product is set in Epilogue, tabular. */}
          <div
            aria-hidden="true"
            className="relative w-11 shrink-0"
            style={{ height: height(DAY_END_MIN - DAY_START_MIN) }}
          >
            {HOURS.map((hour) => (
              <span
                key={hour}
                className="type-time absolute right-0 -translate-y-1/2 text-ink-faint"
                style={{ top: top(hour * 60) }}
              >
                {String(hour).padStart(2, "0")}:00
              </span>
            ))}
          </div>

          {/* The channel. Never raised — the ribbon is material, not a card. */}
          <div
            className="relative flex-1 overflow-hidden rounded-card border border-line bg-surface"
            style={{ height: height(DAY_END_MIN - DAY_START_MIN) }}
          >
            {/* Hour gridlines */}
            {HOURS.slice(1, -1).map((hour) => (
              <div
                key={hour}
                aria-hidden="true"
                className="absolute inset-x-0 h-px bg-line"
                style={{ top: top(hour * 60) }}
              />
            ))}

            <ul className="contents">
              {/* OPEN — accent wash, 1px accent border. The only place hue appears. */}
              <li
                className="absolute inset-x-2 flex items-center justify-between gap-2 rounded-segment border border-accent bg-accent-wash px-3"
                style={{ top: top(9 * 60 + 30), height: height(45) }}
              >
                <span className="type-time text-accent">09:30</span>
                <span className="type-body-sm text-accent">Open · 45 min</span>
              </li>

              {/* BOOKED — sunk and inset, carved into the day. Initials, no hue. */}
              <li
                className="absolute inset-x-2 flex items-center justify-between gap-2 rounded-segment bg-surface-sunk px-3 shadow-inset"
                style={{ top: top(10 * 60 + 30), height: height(60) }}
              >
                <span className="type-time text-ink-muted">10:30</span>
                <span className="type-body-sm font-medium text-ink-muted">
                  Booked · MR
                </span>
              </li>

              {/* BLOCKED — denser hatching over the sunk surface, plus a label. */}
              <li
                className="hatch-dense absolute inset-x-2 flex items-center justify-between gap-2 rounded-segment bg-surface-sunk px-3"
                style={{ top: top(12 * 60), height: height(60) }}
              >
                <span className="type-time text-ink-faint">12:00</span>
                <span className="type-body-sm text-ink-faint">Blocked</span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* Legend. Every state carries a text label — colour is never the only signal. */}
      <section aria-labelledby="legend-heading" className="flex flex-col gap-3">
        <h2 id="legend-heading" className="type-label">
          How to read this
        </h2>
        <ul className="flex flex-col gap-2">
          <li className="type-body-sm flex items-center gap-3 text-ink-muted">
            <span
              aria-hidden="true"
              className="size-5 shrink-0 rounded-segment border border-accent bg-accent-wash"
            />
            Open — you can book this
          </li>
          <li className="type-body-sm flex items-center gap-3 text-ink-muted">
            <span
              aria-hidden="true"
              className="size-5 shrink-0 rounded-segment bg-surface-sunk shadow-inset"
            />
            Booked — taken, shown with the initials
          </li>
          <li className="type-body-sm flex items-center gap-3 text-ink-muted">
            <span
              aria-hidden="true"
              className="hatch-dense size-5 shrink-0 rounded-segment bg-surface-sunk"
            />
            Blocked — the business is closed or away
          </li>
        </ul>
      </section>

      {/* The only raised surface on the page: --shadow-float. */}
      <aside className="rounded-card border border-line bg-surface p-5 shadow-float">
        <p className="type-label">Your slot</p>
        <p className="type-time-lg mt-2 text-ink">09:30 – 10:15</p>
        <p className="type-body-sm mt-1 text-ink-muted">
          Nothing is held yet. Choosing a time reserves it for 8 minutes while
          you check out.
        </p>
      </aside>
    </main>
  );
}
