import { SkeletonPageHeader, SkeletonRows } from "@/components/skeleton";

/** Staff, before the list arrives. */
export default function StaffLoading() {
  return (
    <div className="flex flex-col gap-8">
      <SkeletonPageHeader action />
      <SkeletonRows rows={3} />
    </div>
  );
}
