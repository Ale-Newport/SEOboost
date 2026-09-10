import { Skeleton, SkeletonCard } from '@/components/ui/skeleton';

export default function SiteArchitectureLoading() {
  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3 pb-4">
        <div className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3.5 w-72 max-w-full" />
        </div>
        <Skeleton className="h-8 w-32" />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <SkeletonCard key={index} bodyHeight="sm" />
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-3">
          <Skeleton className="h-11 w-full rounded-lg" />
          <Skeleton className="h-[560px] w-full rounded-lg" />
        </div>
        <Skeleton className="h-72 w-full rounded-lg" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <SkeletonCard key={index} bodyHeight="lg" />
        ))}
      </div>
    </div>
  );
}
