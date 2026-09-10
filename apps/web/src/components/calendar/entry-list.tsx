'use client';

import * as React from 'react';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn, formatNumber, shortenUrl } from '@/lib/utils';
import { stageMeta } from '@/components/content/meta';

import { dayLabel } from './dates';
import { DATE_KIND_LABEL, PHASE_META, phaseOf, type CalendarEntryView } from './types';

/**
 * The list view: the same entries as the grid, in one scannable table.
 *
 * The grid answers "what lands when"; this answers "what is in flight and where has it got to",
 * which is why it carries the exact pipeline stage rather than only the planning phase.
 */

export interface EntryListProps {
  /** Days in ascending date order, matching the way the month reads. */
  days: ReadonlyArray<{ date: string; entries: CalendarEntryView[] }>;
  todayKey: string;
}

export function EntryList({ days, todayKey }: EntryListProps): React.JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] border-collapse text-sm">
        <caption className="sr-only">
          Content entries for this month, grouped by day. Each title links to its draft.
        </caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className="px-3 py-2 text-left text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Entry
            </th>
            <th scope="col" className="px-3 py-2 text-left text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Website
            </th>
            <th scope="col" className="px-3 py-2 text-left text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Target keyword
            </th>
            <th scope="col" className="px-3 py-2 text-left text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Stage
            </th>
            <th scope="col" className="px-3 py-2 text-right text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Words
            </th>
            <th scope="col" className="px-3 py-2 text-left text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Date
            </th>
          </tr>
        </thead>

        {days.map((day) => (
          <tbody key={day.date} className="border-b border-border last:border-b-0">
            <tr className="bg-muted/40">
              <th
                scope="colgroup"
                colSpan={6}
                className="px-3 py-1.5 text-left text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {dayLabel(day.date)}
                {day.date === todayKey ? (
                  <Badge variant="default" className="ml-2">
                    Today
                  </Badge>
                ) : null}
                <span className="ml-2 font-normal normal-case tracking-normal">
                  {day.entries.length} entr{day.entries.length === 1 ? 'y' : 'ies'}
                </span>
              </th>
            </tr>

            {day.entries.map((entry) => {
              const phase = phaseOf(entry);
              const meta = PHASE_META[phase];
              const stage = stageMeta(entry.stage);
              const provisional = entry.dateKind === 'updated';

              return (
                <tr key={entry.id} className="border-t border-border/60 hover:bg-accent/40">
                  <td className="max-w-[22rem] px-3 py-2 align-top">
                    <Link
                      href={`/sites/${entry.websiteId}/content/${entry.id}`}
                      className="flex items-start gap-1.5 font-medium leading-snug text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span
                        aria-hidden="true"
                        className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', meta.dotClass)}
                      />
                      <span className="min-w-0">{entry.title}</span>
                    </Link>
                    {entry.publishedUrl ? (
                      <a
                        href={entry.publishedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-0.5 inline-flex items-center gap-1 font-mono text-2xs text-muted-foreground hover:text-foreground hover:underline"
                      >
                        {shortenUrl(entry.publishedUrl, 52)}
                        <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                      </a>
                    ) : null}
                  </td>

                  <td className="px-3 py-2 align-top">
                    <Link
                      href={`/sites/${entry.websiteId}`}
                      className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      {entry.websiteName}
                    </Link>
                  </td>

                  <td className="px-3 py-2 align-top text-xs">
                    {entry.targetKeyword ? (
                      <span className="text-foreground">{entry.targetKeyword}</span>
                    ) : (
                      <span className="text-muted-foreground">No target keyword set</span>
                    )}
                  </td>

                  <td className="px-3 py-2 align-top">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={meta.tone}>{meta.label}</Badge>
                      <span className="text-2xs text-muted-foreground" title={stage.description}>
                        {stage.label}
                      </span>
                    </div>
                  </td>

                  <td className="tabular px-3 py-2 text-right align-top text-xs text-muted-foreground">
                    {formatNumber(entry.wordCount)}
                  </td>

                  <td className="px-3 py-2 align-top text-xs">
                    <span className={cn(provisional ? 'text-muted-foreground' : 'text-foreground')}>
                      {DATE_KIND_LABEL[entry.dateKind]} {entry.date}
                    </span>
                    {provisional ? (
                      <p className="text-2xs text-muted-foreground">
                        No publish date set — placed on the day it last moved.
                      </p>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
    </div>
  );
}
