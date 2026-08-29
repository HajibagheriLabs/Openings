import { Skeleton, SkeletonRows } from "@/components/skeleton";

/**
 * A customer's own appointment, before it arrives.
 *
 * Same single column as the booking flow, because it is the same person on the
 * same phone — they followed a link out of a confirmation email and want one
 * thing confirmed: that it is still on, and when.
 */
export default function ManageLoading() {
  return (
    <main className="mx-auto flex w-full max-w-[560px] flex-col gap-8 px-5 py-12">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-[15px] w-24" />
        <Skeleton className="h-7 w-56 max-w-full" />
      </div>

      {/* The when, at type-time-lg, and the what underneath it. */}
      <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-5">
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="h-[23px] w-48" />
        <Skeleton className="h-5 w-40" />
      </div>

      <SkeletonRows rows={2} rowHeight={64} />
    </main>
  );
}
