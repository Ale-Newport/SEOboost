import { Skeleton, SkeletonCard, SkeletonTable } from '@/components/ui/skeleton';

/** Mirrors the real layout — header, five metric cards, risk + anchors, then the tables. */
export default function BacklinksLoading() {
  return (
    <div className="space-y-6 px-4 py-6 md:px-6" role="status" aria-label="Loading backlinks">
      <div className="flex flex-wrap items-start justify-between gap-4 pb-4">
        <div className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3.5 w-96 max-w-full" />
        </div>
        <Skeleton className="h-6 w-32" />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <SkeletonCard key={index} bodyHeight="sm" />
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Skeleton className="h-[320px] rounded-lg" />
        <Skeleton className="h-[320px] rounded-lg" />
      </div>

      <SkeletonTable rows={6} columns={6} />
      <SkeletonTable rows={10} columns={8} />

      <span className="sr-only">Loading backlinks…</span>
    </div>
  );
}
