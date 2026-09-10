import Link from 'next/link';
import { FileCode2, FileSearch, Globe, ScanLine, Search } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { MetricCard } from '@/components/ui/metric-card';
import { PageHeader } from '@/components/ui/page-header';
import { Section, SectionDescription, SectionHeader, SectionTitle } from '@/components/ui/section';
import { StatList, StatListItem } from '@/components/ui/stat-list';
import { DiscrepancyTable } from '@/components/indexation/discrepancy-table';
import { SubmissionPanel } from '@/components/indexation/submission-panel';
import { formatNumber } from '@/lib/utils';
import type { IndexationData } from '@/server/queries/indexation';

/**
 * Indexation — the reconciliation between three sources that rarely agree: what we crawled, what
 * the sitemap claims, and what Search Console has data for.
 *
 * The platform reconciles and reports. It cannot force indexation, because Google exposes no
 * general-purpose indexing API — that limit is stated plainly rather than papered over with a
 * button that quietly does nothing.
 */

const GOOGLE_LIMIT =
  'This platform cannot make Google index a page. Google publishes no general-purpose indexing API — ' +
  'its Indexing API accepts only JobPosting and BroadcastEvent structured data — so no tool can push ' +
  'an ordinary URL into the index. What it can do is reconcile the three sources below so the ' +
  'reasons a page is missing are visible, and submit to Bing, which does expose an endpoint.';

export function IndexationView({ data }: { data: IndexationData }): React.JSX.Element {
  const { website, crawl, totals, groups, rows, truncated, scanned, search, bing } = data;
  const siteOrigin = `${website.protocol}://${website.domain}`;

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="Indexation"
        description={`Where the crawl, the sitemap and Search Console disagree about ${website.domain}.`}
      />

      <Alert variant="neutral" title="What can and cannot be done from here">
        {GOOGLE_LIMIT}
      </Alert>

      {crawl === null ? (
        <>
          <EmptyState
            bordered
            icon={ScanLine}
            title="This site has not been crawled yet"
            description="The reconciliation compares crawled pages against the sitemap and Search Console. Without a completed crawl there is nothing on our side of the comparison — run one from the site overview to populate it."
            action={
              <Link
                href={`/sites/${website.id}`}
                className="text-xs font-medium text-primary underline-offset-2 hover:underline"
              >
                Go to the site overview to crawl
              </Link>
            }
          />
          <SubmissionPanel
            websiteId={website.id}
            siteOrigin={siteOrigin}
            bing={bing}
            sitemapDocuments={[]}
          />
        </>
      ) : (
        <>
          {!search.gscConnected ? (
            <Alert variant="info" title="Search Console is not connected for this site">
              Two of the five checks below compare against Search Console impressions. Without it, the
              &ldquo;indexable but absent from Search Console&rdquo; bucket cannot be populated at all,
              and the rest of the picture is crawl-versus-sitemap only.{' '}
              <Link href={`/sites/${website.id}/settings`} className="font-medium underline">
                Connect it in site settings
              </Link>
              .
            </Alert>
          ) : null}

          {truncated ? (
            <Alert variant="warning" title="The site is larger than one reconciliation pass">
              {formatNumber(scanned)} of {formatNumber(totals.pages)} pages were classified, ordered by
              impressions so the pages worth reconciling came first. The counts below describe that
              subset.
            </Alert>
          ) : null}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <MetricCard
              label="Pages known"
              value={formatNumber(totals.pages)}
              icon={FileSearch}
              footer={`${formatNumber(totals.active)} active`}
              info="Every page row stored for this site, including ones the last crawl no longer found."
            />
            <MetricCard
              label="Crawled successfully"
              value={formatNumber(totals.crawledOk)}
              icon={ScanLine}
              footer={`Last crawl fetched ${formatNumber(crawl.pagesCrawled)}`}
              info="Pages fetched with a status below 400. Anything else cannot be judged on content, only on its response."
            />
            <MetricCard
              label="In the sitemap"
              value={formatNumber(totals.inSitemap)}
              icon={FileCode2}
              footer={
                totals.sitemapEntriesNotSeen > 0
                  ? `${formatNumber(totals.sitemapEntriesNotSeen)} sitemap entries never became a page`
                  : `${formatNumber(crawl.sitemapUrlCount)} URLs listed`
              }
              info="Pages our crawler matched to an entry in a sitemap document it fetched."
            />
            <MetricCard
              label="Indexable"
              value={formatNumber(totals.indexable)}
              icon={Globe}
              footer={`${formatNumber(totals.nonIndexable)} excluded from indexing`}
              info="Active pages with no meta robots, X-Robots-Tag, robots.txt rule or status code preventing indexing."
            />
            <MetricCard
              label="Seen in Search Console"
              value={search.hasSearchData ? formatNumber(totals.withSearchData) : '—'}
              icon={Search}
              footer={
                search.hasSearchData
                  ? 'Pages with impressions in the last 28 days'
                  : 'Connect Search Console to populate'
              }
              info="Impressions are evidence a page was served for something. Zero impressions is not proof of non-indexation — an indexed page can simply never surface."
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <Card>
              <CardHeader>
                <CardTitle>Sources being reconciled</CardTitle>
                <CardDescription>
                  Three independent views of the same site. Every row in the table below is a place two
                  of them disagree.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <StatList divided dense>
                  <StatListItem
                    label="Our crawl"
                    value={`${formatNumber(crawl.pagesCrawled)} pages`}
                    hint={
                      crawl.finishedAt
                        ? `Completed ${crawl.finishedAt.toLocaleDateString(undefined, {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })}.`
                        : 'The most recent completed crawl.'
                    }
                  />
                  <StatListItem
                    label="robots.txt"
                    value={crawl.robotsTxtFound ? 'Found and respected' : 'Not found'}
                    muted={!crawl.robotsTxtFound}
                    hint="The crawler obeys it. A missing file is not an error, but it means no crawl directives are being published either."
                  />
                  <StatListItem
                    label="Sitemap documents"
                    value={formatNumber(crawl.sitemapDocuments.length)}
                    muted={crawl.sitemapDocuments.length === 0}
                    hint="Index files and children the crawler actually fetched."
                  />
                  <StatListItem
                    label="Sitemap URL entries"
                    value={formatNumber(crawl.sitemapUrlCount)}
                    muted={crawl.sitemapUrlCount === 0}
                  />
                  <StatListItem
                    label="Search Console"
                    value={search.gscConnected ? 'Connected' : (search.gscStatus ?? 'Not connected')}
                    muted={!search.gscConnected}
                    hint={
                      search.gscLastSyncAt
                        ? `Last synced ${search.gscLastSyncAt.toLocaleDateString(undefined, {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })}.`
                        : 'No sync has completed yet.'
                    }
                  />
                  <StatListItem
                    label="Bing Webmaster Tools"
                    value={bing.configured ? (bing.siteUrl ?? 'Configured, property not resolved') : 'Not configured'}
                    muted={!bing.configured}
                    hint="The only search engine here that accepts URL submissions through an API."
                  />
                </StatList>
              </CardContent>
            </Card>

            <SubmissionPanel
              websiteId={website.id}
              siteOrigin={siteOrigin}
              bing={bing}
              sitemapDocuments={crawl.sitemapDocuments}
            />
          </div>

          <Section spacing="lg">
            <SectionHeader>
              <SectionTitle>Discrepancies</SectionTitle>
              <SectionDescription>
                Five checks, each linking back to the page it concerns. Counts come from every scanned
                page; the table lists up to 250 rows per bucket.
              </SectionDescription>
            </SectionHeader>
            <DiscrepancyTable websiteId={website.id} groups={groups} rows={rows} />
          </Section>
        </>
      )}
    </div>
  );
}
