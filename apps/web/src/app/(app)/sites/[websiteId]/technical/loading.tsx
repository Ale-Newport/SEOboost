import { Skeleton } from '@/components/ui/skeleton';

/**
 * Mirrors the audit layout — header, four metric tiles, the health panel with its breakdown,
 * the category grid and the issue table — so nothing shifts when the real screen arrives.
 */
export default function TechnicalAuditLoading() {
  return (
    <div
      className="space-y-6 px-4 py-6 md:px-6"
      role="status"
      aria-label="Loading the technical audit"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 pb-4">
        <div className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3.5 w-72" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-28" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-[86px] rounded-lg" />
        ))}
      </div>

      {/* Health score and its breakdown */}
      <div className="grid gap-6 rounded-lg border border-border bg-card p-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-8">
        <div className="flex items-start gap-5">
          <Skeleton className="size-[124px] shrink-0 rounded-full" />
          <div className="flex-1 space-y-2.5">
            <Skeleton className="h-3.5 w-32" />
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="flex items-center gap-3">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-2 flex-1 rounded-full" />
                <Skeleton className="h-3 w-9" />
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-3">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-[88px] w-full rounded-lg" />
          <Skeleton className="h-8 w-full" />
        </div>
      </div>

      {/* Category summary */}
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-3 w-96 max-w-full" />
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {Array.from({ length: 10 }, (_, index) => (
            <Skeleton key={index} className="h-[92px] rounded-lg" />
          ))}
        </div>
      </div>

      {/* Issue table */}
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-3 w-[28rem] max-w-full" />
        </div>
        <div className="rounded-lg border border-border bg-card">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
            <Skeleton className="h-8 w-full max-w-xs" />
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-8 w-20" />
          </div>
          <div className="border-t border-border">
            {Array.from({ length: 10 }, (_, index) => (
              <div
                key={index}
                className="flex items-center gap-4 border-b border-border px-3 py-2.5 last:border-b-0"
              >
                <Skeleton className="h-4 w-16 shrink-0" />
                <Skeleton className="h-4 w-24 shrink-0" />
                <Skeleton className="h-4 w-52 shrink-0" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-16 shrink-0" />
              </div>
            ))}
          </div>
        </div>
      </div>

      <span className="sr-only">Loading the technical audit…</span>
    </div>
  );
}
