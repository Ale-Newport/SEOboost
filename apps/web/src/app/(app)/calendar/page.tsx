import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { prisma } from '@seo/db';

import { getCurrentUser } from '@/lib/auth';
import { getContentCalendar } from '@/server/queries/content';
import type { FacetOption } from '@/components/data/filter-bar';
import { CalendarView, type CalendarViewMode } from '@/components/calendar/calendar-view';
import { dateKey, monthEnd, monthKey, monthStart, parseMonthKey } from '@/components/calendar/dates';
import type { CalendarEntryView } from '@/components/calendar/types';

/**
 * The portfolio-wide content calendar.
 *
 * One month at a time, in UTC, so the day an entry sits on is the same day the pipeline
 * recorded. Nothing is projected forward: a draft with no publish date is placed on the day it
 * last moved and labelled as such, rather than being given an invented slot.
 */

export const metadata: Metadata = { title: 'Content calendar' };
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

/** Upper bound on drafts read for one month; the view says so when it is reached. */
const MONTH_LIMIT = 1000;

function paramList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value])
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function paramOne(value: string | string[] | undefined): string | undefined {
  const [first] = paramList(value);
  return first;
}

export default async function CalendarPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const query = await searchParams;

  const websites = await prisma.website.findMany({
    where: { userId: user.id, status: { not: 'ARCHIVED' } },
    select: { id: true, name: true },
    orderBy: [{ name: 'asc' }],
  });
  const ownedIds = websites.map((website) => website.id);

  // A site filter narrows the owned set; it can never widen the scope.
  const requestedSites = new Set(paramList(query.site));
  const websiteIds = requestedSites.size === 0 ? ownedIds : ownedIds.filter((id) => requestedSites.has(id));

  const now = new Date();
  const month = parseMonthKey(paramOne(query.month), now);
  const view: CalendarViewMode = paramOne(query.view) === 'list' ? 'list' : 'month';

  const from = monthStart(month);
  const to = monthEnd(month);
  const fromKey = dateKey(from);
  const toKey = dateKey(to);

  const [calendar, draftCount, bySite] = await Promise.all([
    getContentCalendar({ websiteIds, from, to, limit: MONTH_LIMIT }),
    prisma.contentDraft.count({ where: { websiteId: { in: ownedIds } } }),
    prisma.contentDraft.groupBy({
      by: ['websiteId'],
      where: { websiteId: { in: ownedIds } },
      _count: { _all: true },
    }),
  ]);

  /**
   * The read model's window matches a draft on any of its three dates, then anchors it to the
   * most meaningful one — so a draft edited this month but published last month comes back
   * anchored outside the grid. Those are dropped here rather than being drawn on a day they do
   * not belong to.
   */
  const entries: CalendarEntryView[] = calendar.byDate
    .filter((day) => day.date >= fromKey && day.date <= toKey)
    .flatMap((day) =>
      day.entries.map((entry) => ({
        id: entry.id,
        websiteId: entry.websiteId,
        websiteName: entry.websiteName,
        title: entry.title,
        stage: entry.stage,
        stageStatus: entry.stageStatus,
        targetKeyword: entry.targetKeyword,
        wordCount: entry.wordCount,
        date: entry.date,
        dateKind: entry.dateKind,
        publishedUrl: entry.publishedUrl,
      })),
    );

  const siteCounts = new Map(bySite.map((row) => [row.websiteId, row._count._all]));
  const siteOptions: FacetOption[] = websites
    .map((website) => ({
      value: website.id,
      label: website.name,
      count: siteCounts.get(website.id) ?? 0,
    }))
    .filter((option) => option.count > 0);

  return (
    <CalendarView
      entries={entries}
      month={month}
      view={view}
      todayKey={dateKey(now)}
      currentMonthKey={monthKey({ year: now.getUTCFullYear(), month: now.getUTCMonth() })}
      siteOptions={siteOptions}
      hasWebsites={websites.length > 0}
      hasAnyDrafts={draftCount > 0}
      truncated={calendar.total >= MONTH_LIMIT}
    />
  );
}
