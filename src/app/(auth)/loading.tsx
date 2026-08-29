import { Skeleton } from "@/components/skeleton";

/**
 * A sign-in panel, before it arrives.
 *
 * Inside the auth layout, so the card, the wordmark and the note underneath
 * are already drawn — this is only the form.
 */
export default function AuthLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-[23px] w-56 max-w-full" />
      </div>

      {Array.from({ length: 2 }, (_, index) => (
        <div key={index} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-11 w-full" />
        </div>
      ))}

      <Skeleton className="h-11 w-full" />
    </div>
  );
}
