import { SkeletonPageHeader, SkeletonRows } from "@/components/skeleton";

/** Time off, before the closures arrive. */
export default function TimeOffLoading() {
  return (
    <div className="flex flex-col gap-8">
      <SkeletonPageHeader action />
      <SkeletonRows rows={3} />
    </div>
  );
}
