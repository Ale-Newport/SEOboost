import { Skeleton, SkeletonTable } from '@/components/ui/skeleton';

/** Mirrors the action queue's layout so the page does not jump when the data lands. */
export default function ActionsLoading() {
  return (
    <div className="space-y-4 px-4 py-6 md:px-6">
      <div className="space-y-2 pb-4">
        <Skeleton className="h-6 w-44" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </div>

      <div
        role="status"
        aria-busy="true"
        aria-live="polite"
        className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-4"
      >
        <span className="sr-only">Loading queue totals</span>
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="space-y-2 bg-card px-4 py-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-6 w-12" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>

      <SkeletonTable rows={10} columns={6} />
    </div>
  );
}
