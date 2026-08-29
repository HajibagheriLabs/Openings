import { Skeleton, SkeletonPageHeader } from "@/components/skeleton";

/** Settings, before the delivery counts arrive. */
export default function SettingsLoading() {
  return (
    <div className="flex flex-col gap-8">
      <SkeletonPageHeader />

      <div className="flex flex-col gap-6">
        <Skeleton className="h-44 w-full rounded-card" />
        <Skeleton className="h-36 w-full rounded-card" />
      </div>
    </div>
  );
}
