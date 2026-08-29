import {
  SkeletonPageHeader,
  SkeletonRibbon,
  SkeletonTodayPanel,
} from "@/components/skeleton";

/**
 * The calendar, before the week arrives.
 *
 * Deliberately drawn as the DAY view: it is the default, and a day-shaped
 * placeholder that becomes a week is a smaller surprise than the reverse,
 * because the week is drawn at a smaller zoom and would otherwise shrink under
 * the reader.
 */
export default function CalendarLoading() {
  return (
    <div className="flex flex-col gap-8">
      <SkeletonPageHeader />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <SkeletonRibbon columns={2} columnHeaders label="Loading the calendar" />
        <SkeletonTodayPanel />
      </div>
    </div>
  );
}
