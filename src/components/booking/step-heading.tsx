import type { ReactNode } from "react";

/**
 * The question this step is asking.
 *
 * An `h2` under the business name, with the step's own name as the 11px
 * label above it. The progress line at the top of the page says how far
 * through you are; this says what you are being asked. Neither repeats the
 * other, and neither is a numbered circle.
 */
export function StepHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="type-label">{eyebrow}</p>
      <h2 className="type-page-title text-ink">{title}</h2>
      {description ? (
        <p className="type-body text-ink-muted">{description}</p>
      ) : null}
    </div>
  );
}
