import { Skeleton, SkeletonCard } from '@/components/ui/skeleton';

export default function EntityGraphLoading() {
  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3 pb-4">
        <div className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3.5 w-96 max-w-full" />
        </div>
        <Skeleton className="h-8 w-36" />
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <SkeletonCard key={index} bodyHeight="sm" />
        ))}
      </div>

      <Skeleton className="h-48 w-full rounded-lg" />

      <div className="flex gap-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-8 w-44" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <SkeletonCard key={index} bodyHeight="lg" />
        ))}
      </div>
    </div>
  );
}
