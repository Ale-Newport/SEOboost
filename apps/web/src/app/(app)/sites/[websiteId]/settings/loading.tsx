import { Skeleton, SkeletonCard } from '@/components/ui/skeleton';

export default function SiteSettingsLoading() {
  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <div className="space-y-2 pb-4">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-3.5 w-72 max-w-full" />
      </div>

      <div className="flex gap-4 border-b border-border pb-2">
        {Array.from({ length: 7 }, (_, index) => (
          <Skeleton key={index} className="h-4 w-20" />
        ))}
      </div>

      <SkeletonCard bodyHeight="lg" lines={2} />
      <SkeletonCard bodyHeight="md" />
    </div>
  );
}
