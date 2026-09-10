'use client';

import { useMemo, useState } from 'react';
import { CircleSlash, Quote } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { StatList, StatListItem } from '@/components/ui/stat-list';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { DataTable, type ColumnDef } from '@/components/data/data-table';
import { UrlCell } from '@/components/data/url-cell';
import { formatNumber, formatPercent } from '@/lib/utils';
import type { AiVisibilityRunRow } from '@/server/queries/ai-visibility';

/**
 * Individual observations: one row per answer we recorded.
 *
 * Selecting a row opens the answer snapshot exactly as it was stored, because a rate is only
 * trustworthy if you can read the text it was counted from. `method` distinguishes an answer we
 * queried through a provider API from one an operator pasted in by hand — the two are never
 * silently mixed into one claim.
 */

const SENTIMENT_TONE: Record<string, 'success' | 'warning' | 'destructive' | 'muted'> = {
  positive: 'success',
  neutral: 'muted',
  negative: 'destructive',
};

function providerLabel(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function runDateTime(value: Date): string {
  return value.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function RunsTable({
  runs,
  totalRuns,
  brandName,
}: {
  runs: readonly AiVisibilityRunRow[];
  totalRuns: number;
  brandName: string;
}): React.JSX.Element {
  const [active, setActive] = useState<AiVisibilityRunRow | null>(null);

  const columns = useMemo<Array<ColumnDef<AiVisibilityRunRow>>>(
    () => [
      {
        id: 'promptText',
        header: 'Prompt',
        accessor: (row) => row.promptText,
        cell: (row) => (
          <div className="min-w-0 space-y-1">
            <p className="line-clamp-2 text-xs leading-relaxed text-foreground">{row.promptText}</p>
            {row.promptCategory ? <Badge variant="outline">{row.promptCategory}</Badge> : null}
          </div>
        ),
        sortable: true,
        width: 300,
        sticky: true,
      },
      {
        id: 'provider',
        header: 'Provider',
        accessor: (row) => row.provider,
        cell: (row) => (
          <div className="space-y-0.5">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium text-foreground">{providerLabel(row.provider)}</span>
              <Badge variant={row.method === 'manual' ? 'warning' : 'muted'}>
                {row.method === 'manual' ? 'Imported' : 'API'}
              </Badge>
            </div>
            {row.model ? <p className="truncate font-mono text-2xs text-muted-foreground">{row.model}</p> : null}
          </div>
        ),
        sortable: true,
        width: 170,
      },
      {
        id: 'runAt',
        header: 'Observed',
        accessor: (row) => row.runAt,
        cell: (row) => (
          <time dateTime={row.runAt.toISOString()} className="tabular text-xs">
            {runDateTime(row.runAt)}
          </time>
        ),
        sortable: true,
        width: 170,
      },
      {
        id: 'brandMentioned',
        header: 'Brand named',
        accessor: (row) => (row.brandMentioned ? 1 : 0),
        cell: (row) =>
          row.brandMentioned ? (
            <Badge variant="success">Named</Badge>
          ) : (
            <Badge variant="muted">Absent</Badge>
          ),
        exportValue: (row) => (row.brandMentioned ? 'named' : 'absent'),
        sortable: true,
        width: 120,
      },
      {
        id: 'brandPosition',
        header: 'Position',
        headerLabel: 'Position among named brands',
        accessor: (row) => row.brandPosition,
        cell: (row) =>
          row.brandPosition === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <span className="tabular">#{row.brandPosition}</span>
          ),
        sortable: true,
        align: 'right',
        width: 100,
      },
      {
        id: 'competitorsMentioned',
        header: 'Competitors',
        accessor: (row) => row.competitorsMentioned.length,
        cell: (row) =>
          row.competitorsMentioned.length === 0 ? (
            <span className="text-muted-foreground">None</span>
          ) : (
            <span className="truncate text-xs" title={row.competitorsMentioned.join(', ')}>
              {row.competitorsMentioned.slice(0, 2).join(', ')}
              {row.competitorsMentioned.length > 2 ? ` +${row.competitorsMentioned.length - 2}` : ''}
            </span>
          ),
        exportValue: (row) => row.competitorsMentioned.join(' | '),
        sortable: true,
        width: 200,
      },
      {
        id: 'ourUrlsCited',
        header: 'Cited URLs',
        accessor: (row) => row.ourUrlsCited.length,
        cell: (row) => (
          <span className="tabular text-xs">
            {formatNumber(row.ourUrlsCited.length)}
            <span className="text-muted-foreground"> of {formatNumber(row.citedUrls.length)}</span>
          </span>
        ),
        exportValue: (row) => `${row.ourUrlsCited.length}/${row.citedUrls.length}`,
        sortable: true,
        align: 'right',
        width: 120,
      },
      {
        id: 'brandSentiment',
        header: 'Sentiment',
        accessor: (row) => row.brandSentiment ?? '',
        cell: (row) =>
          row.brandSentiment ? (
            <Badge variant={SENTIMENT_TONE[row.brandSentiment] ?? 'muted'}>{row.brandSentiment}</Badge>
          ) : (
            <span className="text-muted-foreground">Not classified</span>
          ),
        sortable: true,
        width: 130,
      },
    ],
    [],
  );

  return (
    <>
      <DataTable
        data={runs}
        columns={columns}
        getRowId={(row) => row.id}
        caption="Recorded AI answers, newest first"
        searchable
        searchPlaceholder="Search prompts and providers…"
        searchKeys={['promptText', 'provider']}
        defaultSort="runAt"
        defaultOrder="desc"
        itemLabel="runs"
        exportFilename="ai-visibility-runs"
        stickyHeader
        maxHeight={620}
        onRowClick={(row) => setActive(row)}
        emptyTitle="No answers have been recorded yet"
        emptyDescription="Run the tracked prompts against a configured provider, or import an answer you collected by hand."
        toolbarActions={
          totalRuns > runs.length ? (
            <span className="text-2xs text-muted-foreground">
              Showing the {formatNumber(runs.length)} most recent of {formatNumber(totalRuns)} recorded runs
            </span>
          ) : null
        }
      />

      <Sheet open={active !== null} onOpenChange={(open) => setActive(open ? active : null)}>
        <SheetContent side="right" className="sm:max-w-xl">
          {active ? (
            <>
              <SheetHeader>
                <SheetTitle>Answer snapshot</SheetTitle>
                <SheetDescription>
                  {providerLabel(active.provider)}
                  {active.model ? ` · ${active.model}` : ''} · {runDateTime(active.runAt)}
                </SheetDescription>
              </SheetHeader>

              <SheetBody className="space-y-5">
                <section className="space-y-1.5">
                  <h4 className="text-xs font-semibold text-foreground">Prompt</h4>
                  <p className="rounded-md border border-border bg-muted/40 p-3 text-sm leading-relaxed text-foreground">
                    {active.promptText}
                  </p>
                </section>

                <StatList dense divided>
                  <StatListItem
                    label="Collection method"
                    value={active.method === 'manual' ? 'Imported by hand' : 'Provider API'}
                    hint={
                      active.method === 'manual'
                        ? 'An operator ran the prompt in the assistant’s own interface and pasted the answer back. The platform never drives a restricted interface.'
                        : 'Queried directly through the provider’s API.'
                    }
                  />
                  <StatListItem
                    label={`${brandName} named`}
                    value={active.brandMentioned ? 'Yes' : 'No'}
                    muted={!active.brandMentioned}
                  />
                  <StatListItem
                    label="Position among brands"
                    value={active.brandPosition === null ? 'Not applicable' : `#${active.brandPosition}`}
                    muted={active.brandPosition === null}
                    hint="How many other named brands appear before ours in the answer text."
                  />
                  <StatListItem
                    label="Sentiment"
                    value={active.brandSentiment ?? 'Not classified'}
                    muted={active.brandSentiment === null}
                    hint="How a model read the answer's tone towards our brand when it parsed it. That is a judgement about the text, not a measurement — the stored answer above is the record to check it against."
                  />
                  <StatListItem
                    label="Parse confidence"
                    value={formatPercent(active.confidence * 100, 0)}
                    hint="How confident the parser is in what it extracted from the answer. A pasted transcript is an exact record, so it scores 100%."
                  />
                </StatList>

                {active.error ? (
                  <p className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/[0.07] p-2.5 text-xs leading-relaxed text-foreground">
                    <CircleSlash aria-hidden="true" className="mt-px size-3.5 shrink-0 text-destructive" />
                    <span>This run recorded an error and is excluded from every rate: {active.error}</span>
                  </p>
                ) : null}

                <section className="space-y-2">
                  <h4 className="text-xs font-semibold text-foreground">
                    Cited URLs{' '}
                    <span className="font-normal text-muted-foreground">
                      ({formatNumber(active.ourUrlsCited.length)} on your domain)
                    </span>
                  </h4>
                  {active.citedUrls.length === 0 ? (
                    <p className="text-sm text-muted-foreground">The answer cited no sources.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {active.citedUrls.map((url) => (
                        <li key={url} className="flex items-center gap-2">
                          <UrlCell url={url} maxLength={52} />
                          {active.ourUrlsCited.includes(url) ? <Badge variant="success">Ours</Badge> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {active.competitorsMentioned.length > 0 ? (
                  <section className="space-y-2">
                    <h4 className="text-xs font-semibold text-foreground">Competitors named</h4>
                    <ul className="flex flex-wrap gap-1.5">
                      {active.competitorsMentioned.map((name) => (
                        <li key={name}>
                          <Badge variant="outline">{name}</Badge>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                <section className="space-y-2">
                  <h4 className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    <Quote aria-hidden="true" className="size-3.5 text-muted-foreground" />
                    The answer, as recorded
                    <TooltipInfo
                      label="Why the raw answer is stored"
                      content="Every rate on this screen is counted from these texts. Keeping the answer makes each number auditable instead of asking you to take it on trust."
                    />
                  </h4>
                  <p className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-xs leading-relaxed text-foreground">
                    {active.answerText}
                  </p>
                  {active.answerTruncated ? (
                    <p className="text-2xs text-muted-foreground">
                      Truncated for display — the full answer is stored intact.
                    </p>
                  ) : null}
                </section>
              </SheetBody>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
