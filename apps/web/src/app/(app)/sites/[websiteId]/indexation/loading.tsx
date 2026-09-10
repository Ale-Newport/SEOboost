import { Skeleton, SkeletonCard, SkeletonTable } from '@/components/ui/skeleton';

/** Mirrors the real layout — header, note, five counts, sources + submission, discrepancy table. */
export default function IndexationLoading() {
  return (
    <div className="space-y-6 px-4 py-6 md:px-6" role="status" aria-label="Loading indexation">
      <div className="space-y-2 pb-4">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-3.5 w-96 max-w-full" />
      </div>

      <Skeleton className="h-20 rounded-lg" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <SkeletonCard key={index} bodyHeight="sm" />
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Skeleton className="h-[360px] rounded-lg" />
        <Skeleton className="h-[360px] rounded-lg" />
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap gap-4">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-7 w-32" />
          ))}
        </div>
        <SkeletonTable rows={10} columns={7} />
      </div>

      <span className="sr-only">Loading indexation…</span>
    </div>
  );
}
