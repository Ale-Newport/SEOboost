'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Play, RotateCw, X } from 'lucide-react';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { apiPost, ApiError } from '@/lib/api-client';
import { formatNumber, cn } from '@/lib/utils';
import type { SiteOverview } from '@/server/queries/site-overview';

type Crawl = SiteOverview['latestCrawl'];

const STATUS_VARIANT = {
  QUEUED: 'secondary',
  RUNNING: 'default',
  COMPLETED: 'success',
  FAILED: 'destructive',
  CANCELLED: 'outline',
} as const;

/**
 * Live crawl status. Polls only while a crawl is actually in flight, and stops when the tab is
 * hidden — a background tab should not keep hitting the API for a job it cannot show.
 */
export function CrawlStatusCard({
  websiteId,
  crawl,
  compact = false,
}: {
  websiteId: string;
  crawl: Crawl;
  compact?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const isActive = crawl?.status === 'RUNNING' || crawl?.status === 'QUEUED';

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    const tick = () => {
      if (document.visibilityState === 'visible' && !cancelled) router.refresh();
    };
    const timer = window.setInterval(tick, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isActive, router]);

  const startCrawl = useCallback(async () => {
    setBusy(true);
    try {
      const result = await apiPost<{ enqueued: boolean; reason?: string }>(
        `/api/websites/${websiteId}/crawl`,
        {},
      );
      if (result.enqueued === false) {
        toast.warning('Crawl queued but no worker is connected', {
          description: 'Start the worker process (npm run dev:worker) or check REDIS_URL.',
        });
      } else {
        toast.success('Crawl started');
      }
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not start the crawl');
    } finally {
      setBusy(false);
    }
  }, [websiteId, router]);

  const cancelCrawl = useCallback(async () => {
    if (!crawl) return;
    setBusy(true);
    try {
      await apiPost(`/api/websites/${websiteId}/crawl/${crawl.id}/cancel`, {});
      toast.success('Cancelling the crawl…');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not cancel the crawl');
    } finally {
      setBusy(false);
    }
  }, [websiteId, crawl, router]);

  const progress =
    crawl && crawl.pagesDiscovered > 0
      ? Math.min(100, Math.round((crawl.pagesCrawled / crawl.pagesDiscovered) * 100))
      : 0;

  const body = (
    <div className="space-y-3">
      {!crawl ? (
        <p className="text-xs text-muted-foreground">
          This site has never been crawled. A crawl populates the page inventory, technical audit
          and internal link graph.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <Badge variant={STATUS_VARIANT[crawl.status] ?? 'secondary'} className="text-2xs">
              {crawl.status.toLowerCase()}
            </Badge>
            <span className="tabular text-2xs text-muted-foreground">
              {formatNumber(crawl.pagesCrawled)} / {formatNumber(crawl.pagesDiscovered)} pages
            </span>
          </div>

          {isActive && (
            <div className="space-y-1">
              <Progress value={progress} />
              <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                {crawl.progressMessage ?? 'Crawling…'}
              </p>
            </div>
          )}

          {crawl.status === 'COMPLETED' && (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-2xs">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Issues found</dt>
                <dd className="tabular font-medium">{formatNumber(crawl.issuesFound)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Failed</dt>
                <dd className={cn('tabular font-medium', crawl.pagesFailed > 0 && 'text-warning')}>
                  {formatNumber(crawl.pagesFailed)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Sitemap URLs</dt>
                <dd className="tabular font-medium">{formatNumber(crawl.sitemapUrlCount)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">robots.txt</dt>
                <dd className="font-medium">{crawl.robotsTxtFound ? 'Found' : 'Missing'}</dd>
              </div>
            </dl>
          )}

          {crawl.status === 'FAILED' && crawl.error && (
            <p className="rounded-md bg-destructive/10 p-2 text-2xs text-destructive">{crawl.error}</p>
          )}
        </>
      )}

      <div className="flex gap-2">
        {isActive ? (
          <Button variant="outline" size="sm" onClick={() => void cancelCrawl()} disabled={busy} className="flex-1">
            <X className="mr-1.5 h-3.5 w-3.5" />
            Cancel crawl
          </Button>
        ) : (
          <Button size="sm" onClick={() => void startCrawl()} disabled={busy} className="flex-1">
            {crawl ? <RotateCw className="mr-1.5 h-3.5 w-3.5" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
            {crawl ? 'Re-crawl site' : 'Start first crawl'}
          </Button>
        )}
      </div>
    </div>
  );

  if (compact) return body;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Crawl</CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
