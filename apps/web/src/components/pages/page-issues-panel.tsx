import Link from 'next/link';
import { CheckCircle2, ScanLine, Wand2 } from 'lucide-react';
import { SEVERITY_ORDER } from '@seo/shared';

import { Badge, SeverityBadge, StatusBadge, type Severity } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { formatNumber } from '@/lib/utils';
import type { PageProfile } from '@/server/queries/pages';

/**
 * Open technical issues recorded against this URL.
 *
 * Only `OPEN` and `REGRESSED` rows are listed: a resolved issue is history, and mixing the two
 * would make the count on this card disagree with the count in the audit. Every row carries the
 * rule's own recommendation — the audit wrote it, so nothing here is invented at render time.
 */

type PageIssue = PageProfile['issues'][number];

export interface PageIssuesPanelProps {
  websiteId: string;
  issues: PageIssue[];
  hasCrawl: boolean;
}

const SEVERITY_VALUES = new Set<string>(SEVERITY_ORDER);

function toSeverity(value: string): Severity {
  return SEVERITY_VALUES.has(value) ? (value as Severity) : 'INFO';
}

function severityRank(value: string): number {
  const index = (SEVERITY_ORDER as readonly string[]).indexOf(value);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

/** `META_TITLE` → `Meta title`; the category enum is not written for humans. */
function humanizeCategory(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const DATE_FORMAT: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };

function IssueRow({ issue, websiteId }: { issue: PageIssue; websiteId: string }): React.JSX.Element {
  return (
    <li className="space-y-1.5 border-b border-border/70 px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <SeverityBadge severity={toSeverity(issue.severity)} />
        <h4 className="min-w-0 flex-1 text-xs font-semibold text-foreground">{issue.title}</h4>
        {issue.status === 'REGRESSED' ? <StatusBadge status="REGRESSED" /> : null}
        {issue.autoFixable ? (
          <Badge variant="info">
            <Wand2 className="size-3" aria-hidden="true" />
            Auto-fixable
          </Badge>
        ) : null}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">{issue.description}</p>

      <p className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs leading-relaxed text-foreground">
        <span className="font-medium">Fix: </span>
        {issue.recommendation}
      </p>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
        <Badge variant="outline">{humanizeCategory(issue.category)}</Badge>
        <span className="font-mono">{issue.ruleId}</span>
        <span>Last seen {issue.lastSeenAt.toLocaleDateString(undefined, DATE_FORMAT)}</span>
        <Link
          href={`/sites/${websiteId}/technical?rule=${encodeURIComponent(issue.ruleId)}`}
          className="ml-auto font-medium text-primary hover:underline"
        >
          Open in the audit
          <span className="sr-only"> for {issue.title}</span>
        </Link>
      </div>
    </li>
  );
}

export function PageIssuesPanel({ websiteId, issues, hasCrawl }: PageIssuesPanelProps): React.JSX.Element {
  const open = issues
    .filter((issue) => issue.status === 'OPEN' || issue.status === 'REGRESSED')
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.title.localeCompare(b.title));

  const resolved = issues.length - open.length;
  const autoFixable = open.filter((issue) => issue.autoFixable).length;

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Technical issues
          {open.length > 0 ? <Badge variant="destructive">{formatNumber(open.length)}</Badge> : null}
        </CardTitle>
        <CardDescription>
          Rules the last audit found broken on this exact URL, worst first.
          {autoFixable > 0
            ? ` ${formatNumber(autoFixable)} can be fixed automatically from the audit screen.`
            : ''}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex-1 px-0 pb-0">
        {open.length === 0 ? (
          <div className="px-5 pb-5">
            {!hasCrawl ? (
              <EmptyState
                size="sm"
                icon={ScanLine}
                title="This page has never been audited"
                description="The technical audit runs against a completed crawl. Until one exists, an empty list means nothing has been checked — not that the page is clean."
                action={
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/sites/${websiteId}`}>Start a crawl</Link>
                  </Button>
                }
              />
            ) : (
              <EmptyState
                size="sm"
                icon={CheckCircle2}
                title="No open issues on this URL"
                description={
                  resolved > 0
                    ? `Every rule passes as of the last audit. ${formatNumber(resolved)} previously recorded issue${resolved === 1 ? ' has' : 's have'} been resolved.`
                    : 'Every rule the audit checks passes on this page.'
                }
                action={
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/sites/${websiteId}/technical`}>See site-wide issues</Link>
                  </Button>
                }
              />
            )}
          </div>
        ) : (
          <>
            <ul>
              {open.map((issue) => (
                <IssueRow key={issue.id} issue={issue} websiteId={websiteId} />
              ))}
            </ul>
            {resolved > 0 ? (
              <p className="flex items-center gap-1 border-t border-border px-4 py-2.5 text-2xs text-muted-foreground">
                {formatNumber(resolved)} issue{resolved === 1 ? '' : 's'} on this URL already resolved
                <TooltipInfo
                  content="Resolved issues stay on the record so a rule that breaks again is reported as a regression rather than as something new."
                  label="Why resolved issues are kept"
                />
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
