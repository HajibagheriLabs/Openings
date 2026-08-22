import Link from "next/link";

/**
 * What has been chosen so far, and a way back to each choice.
 *
 * The browser's back button already works — the state is in the URL, so going
 * back IS going to the previous step — but "back three times to change the
 * stylist" is a thing people are asked to do and do not do. Each chip is a
 * link straight to the step that set it, with everything downstream dropped,
 * so changing the service cannot leave a Tuesday behind that belonged to a
 * different service.
 *
 * Chips only appear for steps that exist. A one-service business never sees a
 * "Cut and finish" chip it could not have chosen otherwise.
 */
export interface BookingChoice {
  /** What was chosen — a service name, a staff member, a date. */
  value: string;
  /** For the accessible name: "Change service". */
  noun: string;
  /** Where to go to change it. */
  href: string;
}

export function BookingChoices({ choices }: { choices: BookingChoice[] }) {
  if (choices.length === 0) {
    return null;
  }

  return (
    <nav aria-label="Your choices so far">
      <ul className="flex flex-wrap items-center gap-2">
        {choices.map((choice) => (
          <li key={choice.noun}>
            <Link
              href={choice.href}
              aria-label={`Change ${choice.noun}: ${choice.value}`}
              className="type-body-sm inline-flex h-8 items-center gap-2 rounded-pill border border-line bg-surface px-3 text-ink-muted hover:border-line-strong hover:text-ink"
            >
              <span className="max-w-[16ch] truncate text-ink">
                {choice.value}
              </span>
              <span className="text-ink-faint">Change</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
