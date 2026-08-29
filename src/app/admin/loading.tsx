import {
  SkeletonPageHeader,
  SkeletonRibbon,
  SkeletonTodayPanel,
} from "@/components/skeleton";

/**
 * Today, before the day arrives.
 *
 * The frame around this — the rail, the top bar, the timezone chip — is the
 * admin layout and is already on screen; only this region is waiting. The
 * shapes below are the real ones at the real scale: a page header, the ribbon
 * in its channel with a lane per staff member, and the summary panel beside
 * it. Nothing shifts when the data lands.
 *
 * A DEFAULT WINDOW HAS TO BE GUESSED HERE, because the business's opening
 * hours are exactly what is still being fetched. 08:00–18:00 is the common
 * case; a shop with a longer day grows the panel once, on the first paint of
 * the real ribbon, and never again.
 */
export default function AdminTodayLoading() {
  return (
    <div className="flex flex-col gap-8">
      <SkeletonPageHeader />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <SkeletonRibbon columns={2} columnHeaders label="Loading today" />
        <SkeletonTodayPanel />
      </div>
    </div>
  );
}
