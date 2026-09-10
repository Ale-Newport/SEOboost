'use client';

import { ExternalLink, ShieldCheck } from 'lucide-react';

import { Badge, SeverityBadge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { formatNumber, formatPercent, shortenUrl } from '@/lib/utils';
import type { AnchorAuditRow } from './types';

const RATIO_EXPLANATION =
  'The share of a page’s inbound internal links whose anchor text is exactly one of its target keywords. ' +
  'Editorial linking produces a mix of phrasings; a profile dominated by one exact-match keyword reads as ' +
  'engineered. Pages with fewer than five inbound links are not audited — the ratio would be noise.';

interface AnchorAuditPanelProps {
  audits: AnchorAuditRow[] | null;
  loading: boolean;
  hasCrawl: boolean;
  crawledAt: string | null;
}

export function AnchorAuditPanel({
  audits,
  loading,
  hasCrawl,
  crawledAt,
}: AnchorAuditPanelProps): React.JSX.Element {
  if (loading) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1, 2, 3].map((index) => (
          <Card key={index} className="p-5">
            <Skeleton className="h-3.5 w-48" />
            <Skeleton className="mt-4 h-2.5 w-full" />
            <Skeleton className="mt-4 h-16 w-full" />
          </Card>
        ))}
      </div>
    );
  }

  if (audits === null || audits.length === 0) {
    return (
      <EmptyState
        bordered
        icon={ShieldCheck}
        title={hasCrawl ? 'No over-optimised anchor profiles' : 'No crawl yet, so no anchors to audit'}
        description={
          hasCrawl
            ? 'No page with five or more inbound internal links gets 45% or more of them from exact-match anchor text. That is what a natural, editorial internal link profile looks like.'
            : 'The audit reads the anchor text stored on the last completed crawl’s link edges. Run a crawl and it will populate.'
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {formatNumber(audits.length)} page{audits.length === 1 ? '' : 's'} whose inbound anchor profile leans
        heavily on exact-match keywords
        {crawledAt ? `, measured on the crawl of ${new Date(crawledAt).toLocaleDateString()}` : ''}. This check
        runs over this product’s own suggestions too — over-optimisation is over-optimisation whoever caused it.
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        {audits.map((audit) => (
          <AnchorAuditCard key={audit.targetPageId} audit={audit} />
        ))}
      </div>
    </div>
  );
}

function AnchorAuditCard({ audit }: { audit: AnchorAuditRow }): React.JSX.Element {
  const percent = Math.round(audit.exactMatchRatio * 100);
  const maxCount = audit.topAnchors.reduce((max, anchor) => Math.max(max, anchor.count), 1);

  return (
    <Card>
      <CardHeader className="gap-1.5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="min-w-0 text-sm">
            <a
              href={audit.targetUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex max-w-full items-center gap-1 truncate underline-offset-4 hover:text-primary hover:underline"
            >
              <span className="truncate">{shortenUrl(audit.targetUrl, 46)}</span>
              <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
            </a>
          </CardTitle>
          <SeverityBadge severity={audit.severity === 'high' ? 'HIGH' : 'MEDIUM'} />
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <ProgressBar
          label={
            <span className="inline-flex items-center gap-1">
              Exact-match anchors
              <TooltipInfo content={RATIO_EXPLANATION} label="How the exact-match ratio is calculated" />
            </span>
          }
          value={percent}
          max={100}
          tone={audit.severity === 'high' ? 'destructive' : 'warning'}
          showValue
          formatValue={() => `${formatPercent(audit.exactMatchRatio, 0)}`}
          ariaLabel={`Exact-match anchor ratio ${percent} percent`}
        />
        <p className="text-2xs text-muted-foreground">
          {formatNumber(audit.exactMatchCount)} of {formatNumber(audit.totalInbound)} inbound internal links.
        </p>

        <div className="space-y-1.5">
          <h4 className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Top anchors</h4>
          <ul className="space-y-1">
            {audit.topAnchors.map((anchor) => (
              <li key={anchor.anchor} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-1.5 shrink-0 rounded-full bg-muted-foreground/30"
                  style={{ width: `${Math.max(6, (anchor.count / maxCount) * 40)}%` }}
                />
                <code className="min-w-0 flex-1 truncate font-mono text-2xs text-foreground">{anchor.anchor}</code>
                <Badge variant="muted" className="shrink-0 tabular">
                  {formatNumber(anchor.count)}
                </Badge>
              </li>
            ))}
          </ul>
        </div>

        <p className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-foreground">
          {audit.recommendation}
        </p>
      </CardContent>
    </Card>
  );
}
