import { Skeleton, SkeletonText } from '@/components/ui/skeleton';

/** Mirrors the queue: header, four risk tiles, tabs, toolbar, then grouped approval cards. */
export default function ApprovalsLoading() {
  return (
    <div className="space-y-4 px-4 py-6 md:px-6" role="status" aria-busy="true" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-4 pb-4">
        <div className="space-y-2">
          <Skeleton className="h-6 w-36" />
          <Skeleton className="h-4 w-full max-w-2xl" />
        </div>
        <Skeleton className="h-8 w-32" />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-[86px] rounded-lg" />
        ))}
      </div>

      <div className="flex gap-4 border-b border-border pb-2">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-5 w-24" />
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
          <Skeleton className="h-8 w-full max-w-xs" />
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-20" />
          <Skeleton className="ml-auto h-8 w-36" />
        </div>

        <div className="space-y-5 border-t border-border p-3">
          {Array.from({ length: 2 }, (_, group) => (
            <div key={group} className="space-y-2">
              <Skeleton className="h-4 w-40" />
              <div className="space-y-3">
                {Array.from({ length: 2 }, (_, card) => (
                  <div key={card} className="space-y-3 rounded-lg border border-border p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Skeleton className="h-4 w-28" />
                      <Skeleton className="h-4 w-20" />
                      <Skeleton className="h-4 w-24" />
                    </div>
                    <Skeleton className="h-4 w-2/3" />
                    <SkeletonText lines={2} />
                    <Skeleton className="h-24 w-full rounded-md" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <span className="sr-only">Loading the approval queue…</span>
    </div>
  );
}
