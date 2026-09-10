import { Skeleton } from '@/components/ui/skeleton';

/**
 * Mirrors the real layout — header, window controls, four metric tiles, the daily chart, the
 * query/page tabs and the breakdowns — so nothing jumps when the measurements arrive.
 */
export default function AnalyticsLoading() {
  return (
    <div
      className="space-y-6 px-4 py-6 md:px-6"
      role="status"
      aria-label="Loading search performance"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 pb-4">
        <div className="space-y-2">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-3.5 w-80" />
        </div>
        <Skeleton className="h-8 w-28" />
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-5 w-52" />
        <Skeleton className="h-3 w-44" />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-[86px] rounded-lg" />
        ))}
      </div>

      {/* Daily series */}
      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-[30rem] max-w-full" />
          </div>
          <Skeleton className="h-8 w-64" />
        </div>
        <Skeleton className="h-[320px] w-full rounded-md" />
        <div className="flex gap-3">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-28" />
        </div>
      </div>

      {/* Queries / pages */}
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-52" />
          <Skeleton className="h-3 w-[32rem] max-w-full" />
        </div>
        <div className="flex gap-4 border-b border-border pb-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-20" />
        </div>
        <div className="rounded-lg border border-border bg-card">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
            <Skeleton className="h-8 w-full max-w-xs" />
            <Skeleton className="ml-auto h-8 w-24" />
          </div>
          <div className="border-t border-border">
            {Array.from({ length: 10 }, (_, index) => (
              <div
                key={index}
                className="flex items-center gap-4 border-b border-border px-3 py-2 last:border-b-0"
              >
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-14 shrink-0" />
                <Skeleton className="h-4 w-16 shrink-0" />
                <Skeleton className="h-4 w-12 shrink-0" />
                <Skeleton className="h-4 w-12 shrink-0" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* CTR gaps */}
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-[28rem] max-w-full" />
        </div>
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>

      {/* Segments */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-72 rounded-lg" />
        <Skeleton className="h-72 rounded-lg" />
      </div>

      <span className="sr-only">Loading search performance…</span>
    </div>
  );
}
