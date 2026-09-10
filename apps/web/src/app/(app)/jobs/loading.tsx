import { Skeleton, SkeletonCard, SkeletonTable } from '@/components/ui/skeleton';

/** Health panel, stats card and the job table — the same three blocks the screen settles into. */
export default function JobsLoading() {
  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <div className="space-y-2">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-3.5 w-96" />
      </div>

      <SkeletonCard bodyHeight="lg" />
      <SkeletonCard bodyHeight="sm" />

      <div className="flex items-center gap-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="ml-auto h-8 w-28" />
      </div>
      <SkeletonTable rows={10} columns={7} />
    </div>
  );
}
