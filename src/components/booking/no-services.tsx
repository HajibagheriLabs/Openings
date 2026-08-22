import { CalendarClock } from "lucide-react";
import type { ReactNode } from "react";

import { BookingShell } from "@/components/booking/booking-shell";
import { EmptyState } from "@/components/empty-state";

/**
 * The business exists, but there is nothing to book.
 *
 * A REAL 200, NOT A 404. The page is genuinely there — somebody typed the
 * address the owner gave them and the owner has not finished setting up, or
 * has switched everything off for the winter. Answering "not found" would tell
 * that visitor the business does not exist, which is both false and the kind
 * of thing they repeat to other people.
 *
 * The same state covers a subtler case: services that exist but are not
 * BOOKABLE — switched off, assigned to nobody active, or a length that does
 * not fit the booking grid. From out here they are all the same fact.
 *
 * No progress line: there is no flow to be partway through.
 */
export function NoServices({
  header,
  contactEmail,
  contactPhone,
}: {
  header: ReactNode;
  contactEmail: string;
  contactPhone: string | null;
}) {
  return (
    <BookingShell header={header}>
      <EmptyState
        icon={CalendarClock}
        title="Nothing to book here yet"
        description="This business has not opened its booking page yet. Get in touch and they will sort you out directly."
        action={
          <div className="flex flex-col items-center gap-2">
            <a
              href={`mailto:${contactEmail}`}
              className="type-section rounded-pill text-accent underline-offset-4 hover:underline"
            >
              {contactEmail}
            </a>
            {contactPhone ? (
              <a
                href={`tel:${contactPhone.replace(/\s+/g, "")}`}
                className="type-section rounded-pill text-accent underline-offset-4 hover:underline"
              >
                {contactPhone}
              </a>
            ) : null}
          </div>
        }
      />
    </BookingShell>
  );
}
