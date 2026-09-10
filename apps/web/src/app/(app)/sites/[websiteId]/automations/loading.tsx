import { Skeleton, SkeletonCard } from '@/components/ui/skeleton';

export default function AutomationsLoading() {
  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <div className="space-y-2 pb-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-3.5 w-96 max-w-full" />
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
        <div className="space-y-6">
          <SkeletonCard bodyHeight="lg" />
          <SkeletonCard bodyHeight="md" />
        </div>
        <SkeletonCard bodyHeight="md" />
      </div>

      <SkeletonCard bodyHeight="lg" />
    </div>
  );
}
