import { Skeleton, SkeletonCard, SkeletonTable } from '@/components/ui/skeleton';

/** Mirrors the real layout — header, note, four KPI tiles, two charts, two tables. */
export default function AiVisibilityLoading() {
  return (
    <div className="space-y-6 px-4 py-6 md:px-6" role="status" aria-label="Loading AI visibility">
      <div className="flex flex-wrap items-start justify-between gap-4 pb-4">
        <div className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3.5 w-96 max-w-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-36" />
          <Skeleton className="h-8 w-24" />
        </div>
      </div>

      <Skeleton className="h-16 rounded-lg" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <SkeletonCard key={index} bodyHeight="sm" />
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <Skeleton className="h-[340px] rounded-lg" />
        <Skeleton className="h-[340px] rounded-lg" />
      </div>

      <SkeletonTable rows={6} columns={7} />
      <SkeletonTable rows={6} columns={8} />

      <span className="sr-only">Loading AI visibility…</span>
    </div>
  );
}
