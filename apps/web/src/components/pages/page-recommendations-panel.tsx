import Link from 'next/link';
import { ArrowRight, CircleAlert, Info, ListChecks, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { cn } from '@/lib/utils';
import type { PageRecommendation } from '@/components/pages/types';

/**
 * What to do about this page next.
 *
 * Every entry is derived server-side from a measurement on this screen — an open critical issue,
 * a title outside the readable range, a query earning less than its position predicts, a word
 * count under the site's own thin-content threshold. Nothing generic is added: an empty list
 * means no rule fired, and the empty state says which inputs produce them.
 */

export interface PageRecommendationsPanelProps {
  recommendations: PageRecommendation[];
  /** Only used to point the empty state at the inputs that produce recommendations. */
  websiteId: string;
}

const TONE: Record<
  PageRecommendation['tone'],
  { icon: typeof Info; accent: string; iconClass: string; label: string }
> = {
  critical: {
    icon: CircleAlert,
    accent: 'border-l-destructive',
    iconClass: 'text-destructive',
    label: 'Critical',
  },
  warning: {
    icon: TriangleAlert,
    accent: 'border-l-warning',
    iconClass: 'text-warning',
    label: 'Worth fixing',
  },
  info: { icon: Info, accent: 'border-l-info', iconClass: 'text-info', label: 'Consider' },
};

const TONE_RANK: Record<PageRecommendation['tone'], number> = { critical: 0, warning: 1, info: 2 };

export function PageRecommendationsPanel({
  recommendations,
  websiteId,
}: PageRecommendationsPanelProps): React.JSX.Element {
  const ordered = [...recommendations].sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);
  const criticalCount = ordered.filter((item) => item.tone === 'critical').length;

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Next steps
          <TooltipInfo
            content="Derived from this page's own data only: its open issues, indexability, title and description lengths, inbound links, word count, crawl depth, structured data and the gap between actual and expected CTR on the queries it ranks for."
            label="Where these recommendations come from"
          />
        </CardTitle>
        <CardDescription>
          {ordered.length === 0
            ? 'Nothing fired for this URL.'
            : criticalCount > 0
              ? `${criticalCount} of these block the page from performing at all — start there.`
              : 'Ordered by how much each one is holding the page back.'}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex-1">
        {ordered.length === 0 ? (
          <EmptyState
            size="sm"
            icon={ListChecks}
            title="No recommendations for this page"
            description="No rule fired against the data held for this URL. If that seems wrong, the inputs may be missing: recommendations need a completed crawl for the document and links, and a connected Search Console for the click-through checks."
            action={
              <Button asChild size="sm" variant="outline">
                <Link href={`/sites/${websiteId}`}>Start a crawl</Link>
              </Button>
            }
            secondaryAction={
              <Button asChild size="sm" variant="ghost">
                <Link href={`/sites/${websiteId}/settings?tab=integrations`}>Check Search Console</Link>
              </Button>
            }
          />
        ) : (
          <ol className="space-y-2.5">
            {ordered.map((item) => {
              const tone = TONE[item.tone];
              const Icon = tone.icon;
              return (
                <li
                  key={item.id}
                  className={cn('space-y-1 rounded-md border border-border border-l-2 bg-card px-3 py-2.5', tone.accent)}
                >
                  <div className="flex items-start gap-2">
                    <Icon className={cn('mt-0.5 size-3.5 shrink-0', tone.iconClass)} aria-hidden="true" />
                    <h4 className="min-w-0 flex-1 text-xs font-semibold text-foreground">
                      <span className="sr-only">{tone.label}: </span>
                      {item.title}
                    </h4>
                  </div>
                  <p className="pl-5 text-xs leading-relaxed text-muted-foreground">{item.detail}</p>
                  {item.href ? (
                    <p className="pl-5">
                      <Link
                        href={item.href}
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      >
                        {item.hrefLabel ?? 'Open'}
                        <ArrowRight className="size-3" aria-hidden="true" />
                        <span className="sr-only"> — {item.title}</span>
                      </Link>
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
