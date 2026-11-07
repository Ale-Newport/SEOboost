import { Skeleton, SkeletonCard, SkeletonTable } from '@/components/ui/skeleton';

/** Mirrors the real layout — header with actions, KPI tiles, tab strip, the inbox list. */
export default function SocialLoading() {
  return (
    <div className="space-y-6 px-4 py-6 md:px-6" role="status" aria-label="Loading social">
      <div className="flex flex-wrap items-start justify-between gap-4 pb-4">
        <div className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3.5 w-96 max-w-full" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-32" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <SkeletonCard key={index} bodyHeight="sm" />
        ))}
      </div>

      <Skeleton className="h-9 w-full max-w-xl" />
      <SkeletonTable rows={8} columns={5} />

      <span className="sr-only">Loading social…</span>
    </div>
  );
}
