import { Skeleton, SkeletonPageHeader, SkeletonTable } from "@/components/skeleton";

/**
 * The customer book, before the rows arrive.
 *
 * The search box is drawn too, at its real 44px, because it is the first thing
 * an owner reaches for on this page and a field that appears late is a field
 * that eats a keystroke.
 */
export default function CustomersLoading() {
  return (
    <div className="flex flex-col gap-8">
      <SkeletonPageHeader />
      <Skeleton className="h-11 w-full max-w-sm" />
      <SkeletonTable rows={6} columns={4} />
    </div>
  );
}
