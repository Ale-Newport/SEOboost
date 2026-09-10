import { Skeleton, SkeletonTable } from '@/components/ui/skeleton';

/** Mirrors the report library's header + table so the page does not jump when data lands. */
export default function ReportsLoading() {
  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <div className="space-y-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-3.5 w-72" />
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="ml-auto h-8 w-36" />
      </div>
      <SkeletonTable rows={8} columns={6} />
    </div>
  );
}
