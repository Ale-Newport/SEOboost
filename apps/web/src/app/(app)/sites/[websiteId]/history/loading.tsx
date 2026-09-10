import { Skeleton, SkeletonText } from '@/components/ui/skeleton';

export default function HistoryLoading() {
  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <div className="space-y-2 pb-4">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-3.5 w-96 max-w-full" />
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="flex flex-wrap gap-2 border-b border-border px-3 py-2.5">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-24" />
        </div>

        <div className="space-y-6 p-4 md:p-5">
          {Array.from({ length: 3 }, (_, group) => (
            <div key={group} className="space-y-3">
              <Skeleton className="h-3 w-40" />
              {Array.from({ length: 3 }, (_, row) => (
                <div key={row} className="space-y-2 pl-8">
                  <Skeleton className="h-3.5 w-64" />
                  <SkeletonText lines={2} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
