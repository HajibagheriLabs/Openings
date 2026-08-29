import { Skeleton, SkeletonPageHeader, SkeletonRows } from "@/components/skeleton";

/**
 * Weekly hours, before they arrive.
 *
 * The staff selector is a pill-height field above seven weekday rows, which is
 * the shape the editor settles into whichever person is chosen.
 */
export default function HoursLoading() {
  return (
    <div className="flex flex-col gap-8">
      <SkeletonPageHeader />
      <Skeleton className="h-11 w-full max-w-xs" />
      <SkeletonRows rows={7} rowHeight={64} />
    </div>
  );
}
