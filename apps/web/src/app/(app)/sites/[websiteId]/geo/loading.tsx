import { Skeleton, SkeletonCard, SkeletonTable } from '@/components/ui/skeleton';

/** Mirrors the real layout — header, note, score ring + four counts, dimensions, findings + history, tables. */
export default function GeoLoading() {
  return (
    <div className="space-y-6 px-4 py-6 md:px-6" role="status" aria-label="Loading GEO readiness">
      <div className="flex flex-wrap items-start justify-between gap-4 pb-4">
        <div className="space-y-2">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-3.5 w-96 max-w-full" />
        </div>
        <Skeleton className="h-8 w-32" />
      </div>

      <Skeleton className="h-20 rounded-lg" />

      <div className="grid gap-4 lg:grid-cols-[auto_minmax(0,1fr)]">
        <Skeleton className="h-[132px] w-full rounded-lg lg:w-[380px]" />
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <SkeletonCard key={index} bodyHeight="sm" />
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <Skeleton className="h-4 w-44" />
        <Skeleton className="h-3.5 w-[32rem] max-w-full" />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 11 }, (_, index) => (
            <SkeletonCard key={index} bodyHeight="sm" />
          ))}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <Skeleton className="h-[300px] rounded-lg" />
        <Skeleton className="h-[300px] rounded-lg" />
      </div>

      <SkeletonTable rows={8} columns={6} />
      <SkeletonTable rows={5} columns={5} />

      <span className="sr-only">Loading GEO readiness…</span>
    </div>
  );
}
