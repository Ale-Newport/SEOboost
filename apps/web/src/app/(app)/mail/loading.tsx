import { Skeleton } from '@/components/ui/skeleton';

/** Mirrors the mail client — header, then mailboxes · list · reader. */
export default function MailLoading() {
  return (
    <div className="space-y-4 px-4 py-6 md:px-6" role="status" aria-label="Loading mail">
      <div className="flex flex-wrap items-start justify-between gap-4 pb-2">
        <div className="space-y-2">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-3.5 w-96 max-w-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-28" />
        </div>
      </div>
      <div className="grid h-[520px] gap-0 overflow-hidden rounded-lg border border-border lg:grid-cols-[220px_minmax(280px,380px)_minmax(0,1fr)]">
        <Skeleton className="hidden h-full rounded-none lg:block" />
        <div className="space-y-2 p-3">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-12" />
          ))}
        </div>
        <Skeleton className="hidden h-full rounded-none lg:block" />
      </div>
      <span className="sr-only">Loading mail…</span>
    </div>
  );
}
