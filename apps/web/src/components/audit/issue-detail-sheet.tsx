'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, ExternalLink, RotateCcw, Sparkles, Wrench } from 'lucide-react';

import { Badge, SeverityBadge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { ErrorState } from '@/components/ui/error-state';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { StatList, StatListItem } from '@/components/ui/stat-list';
import { ApiError, apiGet } from '@/lib/api-client';
import { cn, formatPercent } from '@/lib/utils';
import { EvidenceBlock } from './evidence-block';
import {
  categoryLabel,
  severityLabel,
  statusLabel,
  type AuditIssueRow,
  type RuleReferenceEntry,
} from './types';

interface IssueDetailPayload {
  issue: {
    id: string;
    ruleId: string;
    title: string;
    category: string;
    severity: string;
    status: string;
    url: string | null;
    description: string;
    recommendation: string;
    evidence: unknown;
    estimatedImpact: number;
    confidence: number;
    autoFixable: boolean;
    weight: number;
    fingerprint: string;
    discoveredAt: string;
    lastSeenAt: string;
    resolvedAt: string | null;
    ignoredAt: string | null;
    ignoredReason: string | null;
    crawlId: string | null;
    page: { id: string; url: string; title: string | null } | null;
  };
  action: { id: string; status: string; title: string; priorityScore: number } | null;
}

/** Fixed locale so the drawer reads the same wherever it is opened. */
const DATE_TIME = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatTimestamp(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : DATE_TIME.format(date);
}

export interface IssueDetailSheetProps {
  websiteId: string;
  /** The row that was activated. Rendered immediately; evidence arrives from the API. */
  issue: AuditIssueRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rulesById: Readonly<Record<string, RuleReferenceEntry>>;
  onIgnore: (issue: AuditIssueRow) => void;
  onReopen: (issue: AuditIssueRow) => Promise<boolean> | void;
  onCreateFixAction: (issue: AuditIssueRow) => Promise<unknown> | void;
  busy: boolean;
}

/**
 * Everything known about one finding: what was observed, what to do about it, the rule's own
 * rationale, the evidence it recorded, and the triage controls.
 *
 * The list endpoint does not carry `evidence` (it would dominate every page of results), so the
 * drawer fetches the single issue it is showing. Until that lands, the row's own fields are
 * already on screen — the panel never opens empty.
 */
export function IssueDetailSheet({
  websiteId,
  issue,
  open,
  onOpenChange,
  rulesById,
  onIgnore,
  onReopen,
  onCreateFixAction,
  busy,
}: IssueDetailSheetProps): React.JSX.Element {
  const [detail, setDetail] = useState<IssueDetailPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const issueId = issue?.id ?? null;

  const load = useCallback(async () => {
    if (!issueId) return;
    setLoading(true);
    setError(null);
    try {
      const payload = await apiGet<IssueDetailPayload>(
        `/api/websites/${websiteId}/issues/${issueId}/detail`,
      );
      setDetail(payload);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load this issue.');
    } finally {
      setLoading(false);
    }
  }, [issueId, websiteId]);

  useEffect(() => {
    if (!open || !issueId) {
      setDetail(null);
      setError(null);
      return;
    }
    void load();
  }, [open, issueId, load]);

  // Nothing to describe yet — the drawer only exists once a row has been activated.
  if (!issue) return <></>;

  const rule = rulesById[issue.ruleId];
  const targetUrl = detail?.issue.url ?? issue.url ?? detail?.issue.page?.url ?? null;
  const live = issue.status === 'OPEN' || issue.status === 'REGRESSED';
  const existingAction = detail?.action ?? null;
  const discovered = formatTimestamp(detail?.issue.discoveredAt ?? null) ?? issue.discoveredLabel;
  const lastSeen = formatTimestamp(detail?.issue.lastSeenAt ?? null) ?? issue.lastSeenLabel;
  const ignoredAt = formatTimestamp(detail?.issue.ignoredAt ?? null);
  const resolvedAt = formatTimestamp(detail?.issue.resolvedAt ?? null);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-4 p-5 sm:max-w-xl">
        <SheetHeader>
          <div className="flex flex-wrap items-center gap-1.5">
            <SeverityBadge severity={issue.severity} />
            <Badge variant="outline">{categoryLabel(issue.category)}</Badge>
            <StatusBadge status={issue.status} label={statusLabel(issue.status)} />
            {issue.autoFixable ? (
              <Badge variant="info">
                <Wrench className="size-3" aria-hidden="true" />
                Auto-fixable
              </Badge>
            ) : null}
          </div>
          <SheetTitle>{issue.title}</SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-2xs text-muted-foreground">{issue.ruleId}</span>
            <CopyButton value={issue.ruleId} label={`Copy rule id ${issue.ruleId}`} size="sm" />
          </SheetDescription>
        </SheetHeader>

        <SheetBody className="space-y-5">
          {targetUrl ? (
            <section className="space-y-1.5">
              <h3 className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                Affected URL
              </h3>
              <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2.5 py-2">
                <a
                  href={targetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 break-all font-mono text-2xs leading-relaxed text-foreground underline-offset-4 hover:text-primary hover:underline"
                >
                  {targetUrl}
                </a>
                <CopyButton value={targetUrl} label="Copy URL" size="sm" />
                <a
                  href={targetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open the affected URL in a new tab"
                  className="flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
              </div>
              {detail?.issue.page ? (
                <Link
                  href={`/sites/${websiteId}/pages/${detail.issue.page.id}`}
                  className="inline-flex items-center gap-1 text-2xs text-primary underline-offset-4 hover:underline"
                >
                  Open the page record
                  <ArrowUpRight className="size-3" aria-hidden="true" />
                </Link>
              ) : null}
            </section>
          ) : (
            <p className="rounded-md border border-dashed border-border px-2.5 py-2 text-2xs text-muted-foreground">
              Site-wide finding — it is not tied to a single URL.
            </p>
          )}

          <section className="space-y-1.5">
            <h3 className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              What was found
            </h3>
            <p className="text-xs leading-relaxed text-foreground">
              {detail?.issue.description ?? issue.description}
            </p>
          </section>

          <section className="space-y-1.5">
            <h3 className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              Recommended fix
            </h3>
            <p className="text-xs leading-relaxed text-foreground">
              {detail?.issue.recommendation ?? issue.recommendation}
            </p>
          </section>

          {rule ? (
            <section className="space-y-1.5">
              <h3 className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                Why this rule exists
              </h3>
              <p className="text-xs leading-relaxed text-muted-foreground">{rule.rationale}</p>
            </section>
          ) : null}

          <section className="space-y-1.5">
            <h3 className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              Scoring inputs
            </h3>
            <StatList dense divided>
              <StatListItem
                label="Estimated impact"
                value={formatPercent(detail?.issue.estimatedImpact ?? issue.estimatedImpact, 0)}
                hint="How much of the available benefit this fix is expected to return, on the rule's own 0-100% scale. It feeds the priority score of any action raised from it."
              />
              <StatListItem
                label="Confidence"
                value={formatPercent(detail?.issue.confidence ?? issue.confidence, 0)}
                hint="How sure the rule is that this is a real problem and not a false positive."
              />
              <StatListItem
                label="Rule weight"
                value={rule ? `×${rule.weight}` : detail ? `×${detail.issue.weight}` : '—'}
                hint="Multiplied by the severity weight to give the penalty points this issue charges to its category in the health score."
              />
              <StatListItem
                label="Severity"
                value={severityLabel(issue.severity)}
                hint="Critical ×10, High ×5, Medium ×2, Low ×0.7, Info ×0.1 penalty points."
              />
              {rule ? (
                <StatListItem
                  label="Scope"
                  value={rule.scope === 'site' ? 'Site-wide' : 'Per page'}
                  hint={
                    rule.scope === 'site'
                      ? 'Site-wide findings are not diluted by page count — they cost the same on a large site as on a small one.'
                      : 'Page-level findings are normalised against the number of pages crawled.'
                  }
                />
              ) : null}
            </StatList>
          </section>

          <section className="space-y-1.5">
            <h3 className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              Evidence
            </h3>
            {loading && !detail ? (
              <div className="space-y-2" role="status" aria-live="polite">
                <span className="sr-only">Loading evidence</span>
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3.5 w-1/2" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : error ? (
              <ErrorState
                bordered
                title="Evidence could not be loaded"
                message={error}
                onRetry={() => void load()}
                retrying={loading}
              />
            ) : (
              <EvidenceBlock evidence={detail?.issue.evidence} />
            )}
          </section>

          <section className="space-y-1.5">
            <h3 className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              History
            </h3>
            <StatList dense divided>
              <StatListItem label="First discovered" value={discovered} />
              <StatListItem label="Last seen in a crawl" value={lastSeen} />
              {ignoredAt ? <StatListItem label="Ignored" value={ignoredAt} /> : null}
              {resolvedAt ? <StatListItem label="Resolved" value={resolvedAt} /> : null}
              {detail?.issue.ignoredReason ? (
                <StatListItem label="Ignore reason" value={detail.issue.ignoredReason} />
              ) : null}
            </StatList>
          </section>

          {existingAction ? (
            <Link
              href={`/actions/${existingAction.id}`}
              className={cn(
                'flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2.5 transition-colors',
                'hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              <span className="min-w-0">
                <span className="flex items-center gap-1.5">
                  <Sparkles className="size-3 text-primary" aria-hidden="true" />
                  <span className="text-2xs font-medium text-foreground">Fix action raised</span>
                  <StatusBadge status={existingAction.status} />
                </span>
                <span className="mt-0.5 block truncate text-2xs text-muted-foreground">
                  {existingAction.title}
                </span>
              </span>
              <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Link>
          ) : null}
        </SheetBody>

        <SheetFooter>
          {live ? (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onIgnore(issue)}>
                Ignore
              </Button>
              {issue.autoFixable && !existingAction ? (
                <Button size="sm" disabled={busy} onClick={() => void onCreateFixAction(issue)}>
                  <Sparkles aria-hidden="true" />
                  Create fix action
                </Button>
              ) : null}
            </>
          ) : (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void onReopen(issue)}>
              <RotateCcw aria-hidden="true" />
              Reopen
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
