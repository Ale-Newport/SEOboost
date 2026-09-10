import Link from 'next/link';
import { ArrowDownLeft, ArrowUpRight, Link2, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { UrlCell } from '@/components/data/url-cell';
import { formatNumber, formatPercent } from '@/lib/utils';
import type { PageLinkRow, PageProfile } from '@/server/queries/pages';

/**
 * The link graph around this URL.
 *
 * Edges come from the most recent completed crawl — there is no other record of which page
 * links to which — so with no crawl the lists are empty and say exactly that rather than
 * implying the page has no links.
 */

type LinkSuggestionIn = PageProfile['recommendations']['linkSuggestionsIn'][number];
type LinkSuggestionOut = PageProfile['recommendations']['linkSuggestionsOut'][number];

export interface PageLinksPanelProps {
  websiteId: string;
  hasCrawl: boolean;
  inboundLinks: PageLinkRow[];
  inboundLinkTotal: number;
  outboundLinks: PageLinkRow[];
  outboundLinkTotal: number;
  suggestionsIn: LinkSuggestionIn[];
  suggestionsOut: LinkSuggestionOut[];
}

/** Where on the source page the link sits — a body link carries far more weight than a nav one. */
function placement(link: PageLinkRow): { label: string; variant: 'success' | 'outline' | 'muted' } {
  if (link.inMainContent) return { label: 'In content', variant: 'success' };
  if (link.inNav) return { label: 'Navigation', variant: 'outline' };
  if (link.inFooter) return { label: 'Footer', variant: 'outline' };
  return { label: 'Elsewhere', variant: 'muted' };
}

function LinkRow({ link }: { link: PageLinkRow }): React.JSX.Element {
  const where = placement(link);
  return (
    <li className="flex flex-col gap-1 border-b border-border/70 px-3 py-2.5 last:border-b-0">
      <UrlCell url={link.url} maxLength={56} />
      <div className="flex flex-wrap items-center gap-1.5">
        {link.anchorText && link.anchorText.trim() !== '' ? (
          <span className="min-w-0 break-words text-xs text-muted-foreground">
            &ldquo;{link.anchorText.trim()}&rdquo;
          </span>
        ) : (
          <span className="text-xs italic text-warning">No anchor text</span>
        )}
        <Badge variant={where.variant}>{where.label}</Badge>
        {link.isNofollow ? <Badge variant="warning">nofollow</Badge> : null}
      </div>
    </li>
  );
}

function SuggestionRow({
  url,
  anchorText,
  reason,
  relevanceScore,
  status,
}: {
  url: string;
  anchorText: string;
  reason: string;
  relevanceScore: number;
  status: string;
}): React.JSX.Element {
  return (
    <li className="flex flex-col gap-1 border-b border-border/70 px-3 py-2.5 last:border-b-0">
      <div className="flex items-start justify-between gap-2">
        <UrlCell url={url} maxLength={48} />
        <span className="tabular shrink-0 text-2xs text-muted-foreground">
          {formatPercent(relevanceScore, 0)} relevant
        </span>
      </div>
      <p className="text-xs text-foreground">
        Anchor: <span className="font-medium">&ldquo;{anchorText}&rdquo;</span>
      </p>
      <p className="text-2xs leading-relaxed text-muted-foreground">{reason}</p>
      {status === 'PENDING' ? null : <Badge variant="muted">{status.toLowerCase()}</Badge>}
    </li>
  );
}

function CrawlEmptyState({ websiteId, what }: { websiteId: string; what: string }): React.JSX.Element {
  return (
    <EmptyState
      size="sm"
      icon={Link2}
      title="No crawl to read links from"
      description={`${what} are recorded on the crawl snapshot. Run a crawl of this site and they appear here.`}
      action={
        <Button asChild size="sm" variant="outline">
          <Link href={`/sites/${websiteId}`}>Start a crawl</Link>
        </Button>
      }
    />
  );
}

export function PageLinksPanel({
  websiteId,
  hasCrawl,
  inboundLinks,
  inboundLinkTotal,
  outboundLinks,
  outboundLinkTotal,
  suggestionsIn,
  suggestionsOut,
}: PageLinksPanelProps): React.JSX.Element {
  const pendingCount =
    suggestionsIn.filter((row) => row.status === 'PENDING').length +
    suggestionsOut.filter((row) => row.status === 'PENDING').length;

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>Internal links</CardTitle>
        <CardDescription>
          Edges from the latest completed crawl, plus link suggestions the internal-link agent has proposed
          and nobody has decided on yet.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex-1">
        <Tabs defaultValue="inbound">
          <TabsList>
            <TabsTrigger value="inbound">
              <ArrowDownLeft aria-hidden="true" />
              Inbound
              <span className="tabular text-muted-foreground">{formatNumber(inboundLinkTotal)}</span>
            </TabsTrigger>
            <TabsTrigger value="outbound">
              <ArrowUpRight aria-hidden="true" />
              Outbound
              <span className="tabular text-muted-foreground">{formatNumber(outboundLinkTotal)}</span>
            </TabsTrigger>
            <TabsTrigger value="suggested">
              <Sparkles aria-hidden="true" />
              Suggested
              <span className="tabular text-muted-foreground">{formatNumber(pendingCount)}</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="inbound" className="pt-3">
            <div className="mb-2 flex items-center gap-1 text-2xs text-muted-foreground">
              Pages on this site that link here
              <TooltipInfo
                content="Inbound internal links pass authority and tell crawlers the page matters. Links inside the main content count for far more than a link repeated in every navigation bar."
                label="Why inbound internal links matter"
              />
            </div>
            {!hasCrawl ? (
              <CrawlEmptyState websiteId={websiteId} what="Inbound links" />
            ) : inboundLinks.length === 0 ? (
              <EmptyState
                size="sm"
                icon={Link2}
                title="Nothing on this site links here"
                description="The last crawl found no internal link pointing at this URL, which makes it an orphan: it inherits no authority and is only reachable through the sitemap."
                action={
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/sites/${websiteId}/links`}>Find link opportunities</Link>
                  </Button>
                }
              />
            ) : (
              <>
                <ul className="rounded-md border border-border">
                  {inboundLinks.map((link, index) => (
                    <LinkRow key={`${link.url}-${index}`} link={link} />
                  ))}
                </ul>
                {inboundLinkTotal > inboundLinks.length ? (
                  <p className="pt-2 text-2xs text-muted-foreground">
                    Showing {formatNumber(inboundLinks.length)} of {formatNumber(inboundLinkTotal)} inbound links.{' '}
                    <Link href={`/sites/${websiteId}/architecture`} className="font-medium text-primary hover:underline">
                      Open the link graph
                    </Link>
                  </p>
                ) : null}
              </>
            )}
          </TabsContent>

          <TabsContent value="outbound" className="pt-3">
            <p className="mb-2 text-2xs text-muted-foreground">Links this page points at, in document order</p>
            {!hasCrawl ? (
              <CrawlEmptyState websiteId={websiteId} what="Outbound links" />
            ) : outboundLinks.length === 0 ? (
              <EmptyState
                size="sm"
                icon={Link2}
                title="This page links nowhere"
                description="The crawl recorded no links out of this page. A page with no outgoing links is a dead end for both crawlers and readers."
              />
            ) : (
              <>
                <ul className="rounded-md border border-border">
                  {outboundLinks.map((link, index) => (
                    <LinkRow key={`${link.url}-${index}`} link={link} />
                  ))}
                </ul>
                {outboundLinkTotal > outboundLinks.length ? (
                  <p className="pt-2 text-2xs text-muted-foreground">
                    Showing {formatNumber(outboundLinks.length)} of {formatNumber(outboundLinkTotal)} outbound links.
                  </p>
                ) : null}
              </>
            )}
          </TabsContent>

          <TabsContent value="suggested" className="pt-3">
            {suggestionsIn.length === 0 && suggestionsOut.length === 0 ? (
              <EmptyState
                size="sm"
                icon={Sparkles}
                title="No link suggestions for this page"
                description="Suggestions come from the internal-link agent, which reads every crawled page's text to find a sentence an anchor could genuinely live in. Run it from the internal links screen."
                action={
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/sites/${websiteId}/links`}>Internal links</Link>
                  </Button>
                }
              />
            ) : (
              <div className="space-y-4">
                <p className="flex items-center gap-1 text-2xs text-muted-foreground">
                  Each suggestion carries a relevance percentage and the agent&rsquo;s reason for it
                  <TooltipInfo
                    content="Relevance is the internal-link agent's own 0–100% confidence that the two pages are topically related enough for the anchor to read naturally in place. It ranks the suggestions; it is not a measure of ranking impact."
                    label="What the relevance percentage means"
                  />
                </p>
                {suggestionsIn.length > 0 ? (
                  <section aria-label="Suggested links to this page">
                    <h4 className="pb-1.5 text-xs font-semibold text-foreground">
                      Pages that should link here ({formatNumber(suggestionsIn.length)})
                    </h4>
                    <ul className="rounded-md border border-border">
                      {suggestionsIn.map((row) => (
                        <SuggestionRow
                          key={row.id}
                          url={row.sourceUrl}
                          anchorText={row.anchorText}
                          reason={row.reason}
                          relevanceScore={row.relevanceScore}
                          status={row.status}
                        />
                      ))}
                    </ul>
                  </section>
                ) : null}

                {suggestionsOut.length > 0 ? (
                  <section aria-label="Suggested links from this page">
                    <h4 className="pb-1.5 text-xs font-semibold text-foreground">
                      Pages this one should link to ({formatNumber(suggestionsOut.length)})
                    </h4>
                    <ul className="rounded-md border border-border">
                      {suggestionsOut.map((row) => (
                        <SuggestionRow
                          key={row.id}
                          url={row.targetUrl}
                          anchorText={row.anchorText}
                          reason={row.reason}
                          relevanceScore={row.relevanceScore}
                          status={row.status}
                        />
                      ))}
                    </ul>
                  </section>
                ) : null}

                <p className="text-2xs text-muted-foreground">
                  Suggestions are applied from{' '}
                  <Link href={`/sites/${websiteId}/links`} className="font-medium text-primary hover:underline">
                    Internal links
                  </Link>
                  , where each one is approved or rejected before anything is written.
                </p>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
