import { Skeleton } from '@/components/ui/skeleton';

/** Mirrors the calendar: header with the view toggle, four tiles, month bar, then the grid. */
export default function CalendarLoading() {
  return (
    <div className="space-y-4 px-4 py-6 md:px-6" role="status" aria-busy="true" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-4 pb-4">
        <div className="space-y-2">
          <Skeleton className="h-6 w-44" />
          <Skeleton className="h-4 w-full max-w-2xl" />
        </div>
        <Skeleton className="h-8 w-40 rounded-md" />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-[86px] rounded-lg" />
        ))}
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
          <Skeleton className="size-8 rounded-md" />
          <Skeleton className="size-8 rounded-md" />
          <Skeleton className="h-5 w-36" />
          <Skeleton className="ml-auto h-4 w-72" />
        </div>

        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-24" />
        </div>

        <div className="grid grid-cols-7 gap-px border-t border-border bg-border">
          {Array.from({ length: 7 }, (_, index) => (
            <div key={`head-${index}`} className="bg-card px-2 py-1.5">
              <Skeleton className="h-2.5 w-8" />
            </div>
          ))}
          {Array.from({ length: 35 }, (_, index) => (
            <div key={index} className="h-28 space-y-1.5 bg-card p-2">
              <Skeleton className="h-2.5 w-4" />
              {index % 3 === 0 ? <Skeleton className="h-3 w-full" /> : null}
              {index % 5 === 0 ? <Skeleton className="h-3 w-3/4" /> : null}
            </div>
          ))}
        </div>
      </div>

      <span className="sr-only">Loading the content calendar…</span>
    </div>
  );
}
