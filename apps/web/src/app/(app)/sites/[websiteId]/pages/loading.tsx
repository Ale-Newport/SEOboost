import { Skeleton, SkeletonCard, SkeletonTable } from '@/components/ui/skeleton';

export default function PagesLoading() {
  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <div className="space-y-2 pb-4">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-3.5 w-96 max-w-full" />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <SkeletonCard key={index} bodyHeight="sm" />
        ))}
      </div>

      <SkeletonTable rows={10} columns={7} />
    </div>
  );
}
