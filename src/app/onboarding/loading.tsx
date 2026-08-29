import { Skeleton } from "@/components/skeleton";

/** The setup wizard, before the owner's name arrives. */
export default function OnboardingLoading() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col justify-center gap-6 px-5 py-12">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-[15px] w-20" />
        <Skeleton className="h-7 w-72 max-w-full" />
        <Skeleton className="h-[23px] w-full" />
      </div>

      <div className="flex flex-col gap-5 rounded-card border border-line bg-surface p-6">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-11 w-full" />
          </div>
        ))}

        <Skeleton className="h-11 w-full" />
      </div>
    </main>
  );
}
