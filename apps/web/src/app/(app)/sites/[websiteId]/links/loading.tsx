import { Skeleton, SkeletonCard, SkeletonTable } from '@/components/ui/skeleton';

export default function InternalLinksLoading() {
  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3 pb-4">
        <div className="space-y-2">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-3.5 w-80 max-w-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-36" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <SkeletonCard key={index} bodyHeight="sm" />
        ))}
      </div>

      <div className="flex gap-1.5">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-8 w-28" />
        ))}
      </div>

      <SkeletonTable rows={10} columns={6} />
    </div>
  );
}
