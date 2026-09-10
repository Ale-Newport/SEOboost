'use client';

import { useCallback, useState } from 'react';
import { HandHeart, Search, ShieldCheck } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ProgressBar } from '@/components/ui/progress-bar';
import { toast } from '@/components/ui/toast';
import { UrlCell } from '@/components/data/url-cell';
import { ApiError, apiGet } from '@/lib/api-client';
import { formatNumber } from '@/lib/utils';

/**
 * Places a link could legitimately be earned.
 *
 * NO OUTREACH IS PERFORMED — not here, not downstream. This is a research list built from our own
 * crawl, our own link table and, where a SERP provider is configured, public search results. A
 * human decides whether to contact anyone and does it themselves. The platform sends no email,
 * drafts no message and scrapes no contact details.
 *
 * It is fetched on demand rather than with the page because the unlinked-mention check spends the
 * operator's SERP quota; opening a screen should not cost them a search credit.
 */

const KIND_LABELS: Record<string, string> = {
  UNLINKED_MENTION: 'Unlinked mention',
  BROKEN_INBOUND_LINK: 'Broken inbound link',
  DEAD_EXTERNAL_RESOURCE: 'Dead resource you link to',
  RESOURCE_PAGE: 'Resource page',
  LINKABLE_ASSET: 'Linkable asset of yours',
};

interface Opportunity {
  kind: string;
  url: string;
  domain: string;
  title: string;
  rationale: string;
  suggestedAction: string;
  priority: number;
}

interface SkippedCheck {
  check: string;
  reason: string;
  requiredEnv?: string[];
}

interface OpportunitiesResponse {
  generatedAt: string;
  opportunities: Opportunity[];
  skipped: SkippedCheck[];
}

export function LinkOpportunitiesPanel({ websiteId }: { websiteId: string }): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<OpportunitiesResponse | null>(null);

  const find = useCallback(async () => {
    setPending(true);
    try {
      const response = await apiGet<OpportunitiesResponse>(
        `/api/backlinks/opportunities?websiteId=${encodeURIComponent(websiteId)}`,
      );
      setResult(response);
      if (response.opportunities.length === 0) {
        toast.info('No opportunities found', {
          description:
            response.skipped.length > 0
              ? 'Some checks could not run — the reasons are listed on the panel.'
              : 'Every check ran and found nothing actionable right now.',
        });
      }
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not build the opportunity list.');
    } finally {
      setPending(false);
    }
  }, [websiteId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HandHeart aria-hidden="true" className="size-4 text-muted-foreground" />
          Link opportunities
        </CardTitle>
        <CardDescription>
          Research only: pages that already mention you without linking, dead resources our crawl
          found, and assets of yours worth promoting.
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" loading={pending} loadingText="Checking" onClick={() => void find()}>
            {pending ? null : <Search aria-hidden="true" />}
            {result ? 'Refresh list' : 'Find opportunities'}
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4">
        <Alert variant="neutral" icon={ShieldCheck} title="No automated outreach is performed">
          This platform sends no email, drafts no message, scrapes no contact details and joins no
          link exchange. Buying links, private blog networks and comment or profile injection are out
          of scope by design. Everything below is a list for a person to judge and act on themselves.
        </Alert>

        {result === null ? (
          <EmptyState
            size="sm"
            bordered
            icon={Search}
            title="The list is built on request"
            description="Select “Find opportunities” above to build it. Some checks call a search provider, so it is not run on page load — that would spend your search quota every time you opened this screen."
          />
        ) : (
          <>
            {result.skipped.length > 0 ? (
              <div className="space-y-1.5 rounded-md border border-warning/25 bg-warning/[0.07] p-3">
                <p className="text-xs font-medium text-foreground">
                  {formatNumber(result.skipped.length)} check(s) could not run, so this list is partial
                </p>
                <ul className="space-y-1">
                  {result.skipped.map((check) => (
                    <li key={check.check} className="text-2xs leading-relaxed text-muted-foreground">
                      <span className="font-medium text-foreground">{check.check}</span>: {check.reason}
                      {check.requiredEnv && check.requiredEnv.length > 0 ? (
                        <>
                          {' '}
                          Set{' '}
                          {check.requiredEnv.map((envVar, index) => (
                            <span key={envVar}>
                              {index > 0 ? ' or ' : ''}
                              <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
                                {envVar}
                              </code>
                            </span>
                          ))}
                          .
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {result.opportunities.length === 0 ? (
              <EmptyState
                size="sm"
                title="Nothing actionable found"
                description="Every check that could run found no opening. Re-crawl the site or import a fresh link export, then try again."
              />
            ) : (
              <ul className="space-y-2">
                {result.opportunities.map((opportunity) => (
                  <li
                    key={`${opportunity.kind}:${opportunity.url}`}
                    className="rounded-lg border border-border p-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                      <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium leading-snug text-foreground">{opportunity.title}</p>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline">{KIND_LABELS[opportunity.kind] ?? opportunity.kind}</Badge>
                          <span className="text-2xs text-muted-foreground">{opportunity.domain}</span>
                        </div>
                      </div>
                      <div className="w-28 shrink-0 space-y-1">
                        <p className="text-2xs text-muted-foreground">Priority</p>
                        <ProgressBar
                          value={opportunity.priority}
                          max={100}
                          size="sm"
                          tone={opportunity.priority >= 70 ? 'success' : opportunity.priority >= 40 ? 'warning' : 'muted'}
                          ariaLabel={`Priority ${Math.round(opportunity.priority)} out of 100`}
                        />
                      </div>
                    </div>

                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{opportunity.rationale}</p>
                    <p className="mt-1.5 text-xs leading-relaxed text-foreground">
                      <span className="font-medium">What a person could do: </span>
                      {opportunity.suggestedAction}
                    </p>
                    <div className="mt-2">
                      <UrlCell url={opportunity.url} maxLength={64} />
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <p className="text-2xs text-muted-foreground">
              Built {new Date(result.generatedAt).toLocaleString()} — the list is not stored, so it is
              always current when you ask for it.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
