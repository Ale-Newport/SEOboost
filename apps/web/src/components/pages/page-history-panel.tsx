import Link from 'next/link';
import { History } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { diffWords } from '@/components/content/word-diff';
import { cn, formatNumber, formatPosition } from '@/lib/utils';
import type { PageChange, PageHistoryEntry } from '@/components/pages/types';

/**
 * The snapshot timeline for one page.
 *
 * A snapshot is written whenever a crawl finds the page changed, so this is the only record of
 * *what* changed and when — which is what makes a ranking movement attributable. The before /
 * after is rendered as a word-level diff (`diffWords`, a linear-space LCS already used by the
 * content editor) rather than two paragraphs the reader has to compare by eye.
 */

export interface PageHistoryPanelProps {
  history: PageHistoryEntry[];
  /** Only used to point the empty state at the crawl that would populate it. */
  websiteId: string;
}

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};

/** `first-crawl` → `First crawl`. */
function humanizeReason(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const NOT_SET = '(not set)';

/**
 * Inline word-level diff.
 *
 * Removals keep a strikethrough and additions an underline as well as their colour, so the two
 * are still distinguishable without colour perception.
 */
function InlineDiff({ before, after }: { before: string | null; after: string | null }): React.JSX.Element {
  const segments = diffWords(before ?? '', after ?? '');

  return (
    <p className="text-xs leading-relaxed">
      <span className="sr-only">
        Changed from {before ?? NOT_SET} to {after ?? NOT_SET}.
      </span>
      <span aria-hidden="true">
        {segments.map((segment, index) => {
          if (segment.text === '') return null;
          if (segment.op === 'equal') {
            return (
              <span key={index} className="text-muted-foreground">
                {segment.text}
              </span>
            );
          }
          return (
            <span
              key={index}
              className={cn(
                'rounded-sm px-0.5',
                segment.op === 'delete'
                  ? 'bg-destructive/10 text-destructive line-through decoration-destructive/60'
                  : 'bg-success/10 text-success underline decoration-success/60',
              )}
            >
              {segment.text}
            </span>
          );
        })}
      </span>
    </p>
  );
}

function ChangeRow({ change }: { change: PageChange }): React.JSX.Element {
  const added = change.before === null && change.after !== null;
  const removed = change.after === null && change.before !== null;

  return (
    <li className="space-y-1 rounded-md border border-border bg-muted/30 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          {change.field}
        </span>
        {added ? <Badge variant="success">Added</Badge> : null}
        {removed ? <Badge variant="destructive">Removed</Badge> : null}
      </div>

      {added ? (
        <p className="text-xs leading-relaxed text-foreground">{change.after}</p>
      ) : removed ? (
        <p className="text-xs leading-relaxed text-muted-foreground line-through">{change.before}</p>
      ) : (
        <InlineDiff before={change.before} after={change.after} />
      )}

      {change.detail ? <p className="text-2xs text-muted-foreground">{change.detail}</p> : null}
    </li>
  );
}

function EntryMetrics({ entry }: { entry: PageHistoryEntry }): React.JSX.Element {
  const items: Array<{ label: string; value: string }> = [
    { label: 'Words', value: formatNumber(entry.wordCount) },
    ...(entry.seoScore === null ? [] : [{ label: 'SEO', value: String(Math.round(entry.seoScore)) }]),
    ...(entry.geoScore === null ? [] : [{ label: 'GEO', value: String(Math.round(entry.geoScore)) }]),
    ...(entry.clicks28d === null ? [] : [{ label: 'Clicks 28d', value: formatNumber(entry.clicks28d) }]),
    ...(entry.position28d === null ? [] : [{ label: 'Position', value: formatPosition(entry.position28d) }]),
  ];

  return (
    <dl className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline gap-1">
          <dt className="text-2xs uppercase tracking-wide text-muted-foreground">{item.label}</dt>
          <dd className="tabular text-2xs font-medium text-foreground">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PageHistoryPanel({ history, websiteId }: PageHistoryPanelProps): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Change history
          <TooltipInfo
            content="A snapshot is stored every time a crawl finds this page's title, description, headings or body text different from the last one held. It is what lets a ranking movement be traced back to an edit."
            label="How change history is captured"
          />
        </CardTitle>
        <CardDescription>
          {history.length === 0
            ? 'Snapshots are written by the crawler.'
            : `The last ${formatNumber(history.length)} snapshot${history.length === 1 ? '' : 's'} of this page, newest first.`}
        </CardDescription>
      </CardHeader>

      <CardContent>
        {history.length === 0 ? (
          <EmptyState
            size="sm"
            icon={History}
            title="No snapshots for this page yet"
            description="The first snapshot is captured the first time a crawl reaches this URL, and another every time the page's content changes after that. Run a crawl to start the record."
            action={
              <Button asChild size="sm" variant="outline">
                <Link href={`/sites/${websiteId}`}>Start a crawl</Link>
              </Button>
            }
          />
        ) : (
          <ol className="relative space-y-4 border-l border-border pl-5">
            {history.map((entry) => (
              <li key={entry.id} className="relative space-y-2">
                <span
                  className="absolute -left-[1.6rem] top-1.5 size-2 rounded-full border-2 border-background bg-border"
                  aria-hidden="true"
                />
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <time
                    dateTime={entry.capturedAt.toISOString()}
                    className="text-xs font-semibold text-foreground"
                  >
                    {entry.capturedAt.toLocaleString(undefined, DATE_FORMAT)}
                  </time>
                  <Badge variant="outline">{humanizeReason(entry.reason)}</Badge>
                  {entry.isFirst ? <Badge variant="muted">Baseline</Badge> : null}
                </div>

                <EntryMetrics entry={entry} />

                {entry.isFirst ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    The oldest snapshot still held for this page. There is nothing earlier to compare it
                    against, so no change is shown.
                  </p>
                ) : entry.changes.length === 0 ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Metrics were re-recorded; the title, description, H1, body text and status code were all
                    unchanged from the previous snapshot.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {entry.changes.map((change) => (
                      <ChangeRow key={`${entry.id}-${change.field}`} change={change} />
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
