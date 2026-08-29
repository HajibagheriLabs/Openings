import { Skeleton, SkeletonCalendar } from "@/components/skeleton";

/**
 * The booking page, before the business arrives.
 *
 * ═══ THE SHELL IS DRAWN, NOT WAITED FOR ═══
 *
 * The customer flow is one mobile-first column, 560px at most, and that column
 * exists before anything is known about the shop. So the frame is real here —
 * the same max width, the same gutters, the same room reserved at the bottom
 * for the sticky summary — and only the contents are placeholders. The page
 * never jumps sideways or reflows when the data lands.
 *
 * The month grid is the fallback because every step of the flow that takes
 * time to resolve is the day picker: the service and staff steps are two short
 * lists, and the time step is behind a chosen day. Six week rows, which is the
 * tallest a month gets.
 *
 * No progress line. Which step this is going to be is not yet known, and a bar
 * that guesses and then corrects itself is worse than one that waits.
 */
export default function BookingLoading() {
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="mx-auto flex w-full max-w-[560px] justify-end px-5 pt-4">
        {/* The theme toggle's own 36px square, held open. */}
        <Skeleton className="size-9" />
      </div>

      <main className="mx-auto flex w-full max-w-[560px] flex-1 flex-col gap-8 px-5 pt-2 pb-40">
        {/* The business: name, a line about it, and the timezone note. */}
        <div className="flex flex-col gap-3">
          <Skeleton className="h-7 w-56 max-w-full" />
          <Skeleton className="h-[23px] w-full" />
          <Skeleton className="h-5 w-40" />
        </div>

        {/* The step's question. */}
        <div className="flex flex-col gap-2">
          <Skeleton className="h-[15px] w-16" />
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-[23px] w-64 max-w-full" />
        </div>

        <SkeletonCalendar />
      </main>
    </div>
  );
}
