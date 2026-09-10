'use client';

import { useMemo, useState } from 'react';
import { ExternalLink, ShieldQuestion } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { formatNumber, shortenUrl } from '@/lib/utils';
import type { SchemaDeclinedResponse } from './types';

const DATE_TIME = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/** Enough to see the pattern without turning the top of the screen into a log. */
const COLLAPSED_ROWS = 6;

export interface DeclinedPanelProps {
  data: SchemaDeclinedResponse | null;
  loading: boolean;
}

/**
 * What the generator refused to write, and why.
 *
 * This is deliberately given the same weight as the items that *were* generated. "FAQPage not
 * generated: only 1 genuine Q&A pair is visible on the page" is the sentence that stops an
 * operator hand-writing markup for content that is not on the page — which is the fastest way
 * to earn a manual action. A refusal is a result, not a failure.
 */
export function DeclinedPanel({ data, loading }: DeclinedPanelProps): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);

  const typeCounts = useMemo(
    () =>
      Object.entries(data?.byType ?? {})
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 8),
    [data],
  );

  if (loading && data === null) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <Skeleton className="h-4 w-56" />
        </CardHeader>
        <CardContent className="space-y-2">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (data === null) return null;

  // No completed schema run yet: the panel would be an empty box with no story to tell.
  if (data.run === null) return null;

  const rows = expanded ? data.declined : data.declined.slice(0, COLLAPSED_ROWS);
  const hidden = data.declined.length - rows.length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-1.5">
          Not generated, and why
          <TooltipInfo
            label="Why markup is declined"
            content={
              <>
                The generator only marks up content that is visibly on the page. When the evidence is not there —
                one Q&amp;A instead of a genuine FAQ, a rating with no reviews behind it, a recipe with no
                ingredients — it refuses and records the reason instead of inventing properties. Fabricated
                structured data earns manual actions; a refusal costs nothing.
              </>
            }
          />
        </CardTitle>
        <p className="col-start-1 text-xs text-muted-foreground">
          {formatNumber(data.total)} decision{data.total === 1 ? '' : 's'} from the schema agent run on{' '}
          {DATE_TIME.format(new Date(data.run.startedAt))}
          {data.declined.length < data.total
            ? `. Showing the ${formatNumber(data.declined.length)} example${data.declined.length === 1 ? '' : 's'} the run kept.`
            : '.'}
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {typeCounts.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {typeCounts.map(([type, count]) => (
              <li key={type}>
                <Badge variant="muted">
                  {type}
                  <span className="tabular ml-1 text-foreground/70">{formatNumber(count)}</span>
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}

        {data.declined.length === 0 ? (
          <EmptyState
            size="sm"
            icon={ShieldQuestion}
            title="Nothing was declined in the last run"
            description="Every schema type the agent considered had enough visible evidence on the page to be generated."
          />
        ) : (
          <>
            <ul className="divide-y divide-border/60">
              {rows.map((entry, index) => (
                <li key={`${entry.url}-${entry.schemaType}-${index}`} className="flex gap-3 py-2.5">
                  <Badge variant="outline" className="mt-0.5 h-fit shrink-0">
                    {entry.schemaType}
                  </Badge>
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-sm text-foreground">{entry.reason}</p>
                    <a
                      href={entry.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={entry.url}
                      className="inline-flex max-w-full items-center gap-1 font-mono text-2xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      <span className="truncate">{shortenUrl(entry.url, 60)}</span>
                      <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                    </a>
                  </div>
                </li>
              ))}
            </ul>

            {hidden > 0 || expanded ? (
              <Button variant="ghost" size="sm" onClick={() => setExpanded((value) => !value)}>
                {expanded ? 'Show fewer' : `Show ${formatNumber(hidden)} more`}
              </Button>
            ) : null}
          </>
        )}

        {data.policy ? <p className="text-2xs text-muted-foreground">{data.policy}</p> : null}
      </CardContent>
    </Card>
  );
}
