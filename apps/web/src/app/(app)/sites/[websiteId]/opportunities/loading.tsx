import { Skeleton, SkeletonText } from '@/components/ui/skeleton';

/** Mirrors the real layout — header, four metric cards, toolbar, opportunity cards. */
export default function OpportunitiesLoading() {
  return (
    <div className="space-y-6 px-4 py-6 md:px-6" role="status" aria-label="Loading content opportunities">
      <div className="flex flex-wrap items-start justify-between gap-4 pb-4">
        <div className="space-y-2">
          <Skeleton className="h-5 w-52" />
          <Skeleton className="h-3.5 w-80" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-36" />
          <Skeleton className="h-8 w-36" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-[86px] rounded-lg" />
        ))}
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
          <Skeleton className="h-8 w-full max-w-xs" />
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-24" />
        </div>
        <div className="space-y-3 border-t border-border p-3">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="space-y-3 rounded-lg border border-border p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-48" />
                </div>
                <Skeleton className="h-12 w-16" />
              </div>
              <Skeleton className="h-16 w-full rounded-md" />
              <SkeletonText lines={2} />
              <div className="grid grid-cols-2 gap-4 border-t border-border pt-3 sm:grid-cols-5">
                {Array.from({ length: 5 }, (_, cell) => (
                  <div key={cell} className="space-y-1.5">
                    <Skeleton className="h-2.5 w-16" />
                    <Skeleton className="h-3.5 w-12" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <span className="sr-only">Loading content opportunities…</span>
    </div>
  );
}
