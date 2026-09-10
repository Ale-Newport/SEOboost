import { Skeleton, SkeletonCard, SkeletonTable } from '@/components/ui/skeleton';

/**
 * Mirrors the Competitors layout — header, four metric tiles, a card grid and the gap table — so
 * nothing shifts when the real data lands. Inert geometry only: no count or label is implied.
 */
export default function Loading() {
  return (
    <div className="space-y-6 px-4 py-6 md:px-6" role="status" aria-busy="true">
      <span className="sr-only">Loading competitors</span>

      <div aria-hidden="true" className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
        <div className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-96 max-w-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-32 rounded-md" />
          <Skeleton className="h-8 w-36 rounded-md" />
        </div>
      </div>

      <div aria-hidden="true" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((tile) => (
          <Skeleton key={tile} className="h-24 rounded-lg" />
        ))}
      </div>

      <div aria-hidden="true" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((card) => (
          <SkeletonCard key={card} bodyHeight="lg" />
        ))}
      </div>

      <SkeletonTable rows={8} columns={6} />
    </div>
  );
}
