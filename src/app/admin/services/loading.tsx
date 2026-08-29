import { SkeletonPageHeader, SkeletonRows } from "@/components/skeleton";

/** Services, before the list arrives. */
export default function ServicesLoading() {
  return (
    <div className="flex flex-col gap-8">
      <SkeletonPageHeader action />
      <SkeletonRows rows={4} />
    </div>
  );
}
