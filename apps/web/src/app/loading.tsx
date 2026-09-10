import { Skeleton } from '@/components/ui/skeleton';

/**
 * Root navigation placeholder.
 *
 * It mirrors the authenticated shell's proportions — sidebar rail, top bar, a header and a
 * metric row — so the page does not visibly jump when the real content arrives. Everything
 * here is inert geometry: no number, label or count is implied.
 */
export default function Loading() {
  return (
    <div className="flex min-h-screen bg-background" role="status" aria-busy="true">
      <span className="sr-only">Loading</span>

      <div aria-hidden="true" className="hidden w-[248px] shrink-0 border-r border-border bg-sidebar md:block">
        <div className="flex h-14 items-center gap-2 border-b border-border px-3">
          <Skeleton className="size-6 rounded-sm" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-2 w-16" />
          </div>
        </div>
        <div className="space-y-6 p-3">
          {[0, 1, 2].map((group) => (
            <div key={group} className="space-y-2">
              <Skeleton className="h-2 w-16" />
              {[0, 1, 2].map((item) => (
                <Skeleton key={item} className="h-7 w-full rounded-md" />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div aria-hidden="true" className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 items-center gap-3 border-b border-border px-4 md:px-6">
          <Skeleton className="h-3 w-48" />
          <div className="ml-auto flex items-center gap-2">
            <Skeleton className="h-8 w-40 rounded-md" />
            <Skeleton className="size-8 rounded-md" />
            <Skeleton className="size-8 rounded-md" />
          </div>
        </div>

        <div className="space-y-6 p-4 md:p-6">
          <div className="space-y-2">
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-3 w-80" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((card) => (
              <Skeleton key={card} className="h-24 rounded-lg" />
            ))}
          </div>
          <Skeleton className="h-64 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
