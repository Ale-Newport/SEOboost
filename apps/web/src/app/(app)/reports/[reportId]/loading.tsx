import { Skeleton, SkeletonCard } from '@/components/ui/skeleton';

/** The report body is several independent cards, so the placeholder reserves the same grid. */
export default function ReportDetailLoading() {
  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <div className="space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-6 w-80" />
        <Skeleton className="h-3.5 w-96" />
      </div>

      <SkeletonCard bodyHeight="sm" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <SkeletonCard key={index} bodyHeight="sm" />
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SkeletonCard bodyHeight="lg" />
        <SkeletonCard bodyHeight="lg" />
      </div>
    </div>
  );
}
