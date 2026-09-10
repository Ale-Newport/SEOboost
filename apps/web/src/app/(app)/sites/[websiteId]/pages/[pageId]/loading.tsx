import { Skeleton, SkeletonCard, SkeletonTable } from '@/components/ui/skeleton';

export default function PageDetailLoading() {
  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <div className="space-y-2 pb-4">
        <Skeleton className="h-5 w-72 max-w-full" />
        <Skeleton className="h-3.5 w-[28rem] max-w-full" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <SkeletonCard bodyHeight="md" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <SkeletonCard key={index} bodyHeight="sm" />
          ))}
        </div>
      </div>

      <SkeletonCard bodyHeight="lg" />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <SkeletonTable rows={6} columns={5} />
        <SkeletonCard bodyHeight="lg" lines={2} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <SkeletonCard bodyHeight="lg" lines={3} />
        <SkeletonCard bodyHeight="lg" lines={3} />
      </div>
    </div>
  );
}
