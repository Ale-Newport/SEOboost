import Link from 'next/link';
import { History as HistoryIcon, ListChecks, SearchX } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { formatNumber } from '@/lib/utils';
import { ChangeEntry } from '@/components/history/change-entry';
import { HistoryFilters } from '@/components/history/history-filters';
import { HistoryPagination } from '@/components/history/history-pagination';
import type { HistoryData, HistoryEntry } from '@/components/history/queries';

/**
 * The change timeline for one site.
 *
 * Entries are grouped by day because that is how an operator reads an audit trail — "what
 * happened on Tuesday", not "row 41". The two empty states are deliberately different: nothing
 * has ever happened here (say what would make something happen) versus nothing matches the
 * current filter (say how to clear it).
 */

const DAY = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const SHORT_DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });

interface DayGroup {
  key: string;
  label: string;
  entries: HistoryEntry[];
}

/** Groups the page's entries by calendar day, preserving the newest-first order. */
function groupByDay(entries: readonly HistoryEntry[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const entry of entries) {
    const key = entry.createdAt.toISOString().slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.entries.push(entry);
      continue;
    }
    groups.push({ key, label: DAY.format(entry.createdAt), entries: [entry] });
  }
  return groups;
}

export function HistoryView({ data }: { data: HistoryData }): React.JSX.Element {
  const { website, entries, total, totalUnfiltered, page, pageSize, firstChangeAt } = data;
  const groups = groupByDay(entries);
  const filtered = total !== totalUnfiltered;

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="History"
        description={
          totalUnfiltered === 0 ? (
            <>Every change the platform or a person makes to {website.domain} is recorded here.</>
          ) : (
            <>
              {formatNumber(totalUnfiltered)} recorded change
              {totalUnfiltered === 1 ? '' : 's'} to {website.domain}
              {firstChangeAt ? <> since {SHORT_DATE.format(firstChangeAt)}</> : null}. The trail is
              append-only: a rollback is recorded as a new entry, never as an edit to an old one.
            </>
          )
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/sites/${website.id}/automations`}>
              <ListChecks aria-hidden="true" className="mr-1.5 size-3.5" />
              Automations
            </Link>
          </Button>
        }
      />

      {totalUnfiltered === 0 ? (
        <EmptyState
          bordered
          icon={HistoryIcon}
          title="Nothing has changed this site yet"
          description="This trail fills in as soon as something acts on the site: run an agent from Automations, or approve an action so it executes. Proposals and rejections are recorded here too, not only applied changes."
          action={
            <Button asChild size="sm">
              <Link href={`/sites/${website.id}/automations`}>Go to Automations</Link>
            </Button>
          }
          secondaryAction={
            <Button asChild variant="outline" size="sm">
              <Link href="/approvals">Review approvals</Link>
            </Button>
          }
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="border-b border-border">
            <HistoryFilters
              actorFacets={data.actorFacets}
              changeTypeFacets={data.changeTypeFacets}
              resultCount={total}
            />
          </div>

          {entries.length === 0 ? (
            <div className="p-4">
              <EmptyState
                size="sm"
                icon={SearchX}
                title="No changes match these filters"
                description={
                  filtered
                    ? `This site has ${formatNumber(totalUnfiltered)} recorded change${totalUnfiltered === 1 ? '' : 's'}, but none in this actor, change type or date window. Clear a filter to widen the search.`
                    : 'Try a different page — this one is past the end of the trail.'
                }
              />
            </div>
          ) : (
            <div className="space-y-6 p-4 md:p-5">
              {groups.map((group) => (
                <section key={group.key} aria-labelledby={`day-${group.key}`}>
                  <h2
                    id={`day-${group.key}`}
                    className="sticky top-0 z-10 -mx-1 mb-3 bg-card/95 px-1 py-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur"
                  >
                    {group.label}
                  </h2>
                  {/* The rail line sits on the list; each entry draws its own dot on top of it. */}
                  <ul className="relative before:absolute before:bottom-2 before:left-[13px] before:top-2 before:w-px before:bg-border">
                    {group.entries.map((entry) => (
                      <ChangeEntry key={entry.id} entry={entry} />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}

          <div className="border-t border-border px-3 py-2">
            <HistoryPagination page={page} pageSize={pageSize} total={total} />
          </div>
        </Card>
      )}
    </div>
  );
}
