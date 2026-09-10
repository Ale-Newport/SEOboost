'use client';

import { useCallback, useState } from 'react';
import { Send } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { ApiError, apiPost } from '@/lib/api-client';
import { formatNumber } from '@/lib/utils';

/**
 * URL and sitemap submission — Bing only, and that is not an oversight.
 *
 * Google publishes no general-purpose indexing API. Its Indexing API accepts `JobPosting` and
 * `BroadcastEvent` structured data only, so no platform — this one included — can push an ordinary
 * page into Google's index. Rather than imply otherwise with a button that quietly does nothing,
 * the Google path is absent and the reason is on screen.
 */

const MAX_URLS = 500;

interface SkippedResponse {
  status: 'skipped';
  reason: string;
  fix?: string;
}

interface SubmitResult {
  ok: boolean;
  error?: string;
  submitted?: number;
  feedUrl?: string;
}

type SubmitResponse = SkippedResponse | SubmitResult;

function isSkipped(response: SubmitResponse): response is SkippedResponse {
  return 'status' in response && response.status === 'skipped';
}

export function SubmissionPanel({
  websiteId,
  siteOrigin,
  bing,
  sitemapDocuments,
}: {
  websiteId: string;
  siteOrigin: string;
  bing: { configured: boolean; siteUrl: string | null; status: string | null };
  sitemapDocuments: readonly string[];
}): React.JSX.Element {
  const [feedUrl, setFeedUrl] = useState(sitemapDocuments[0] ?? `${siteOrigin}/sitemap.xml`);
  const [urls, setUrls] = useState('');
  const [pendingTarget, setPendingTarget] = useState<'sitemap' | 'urls' | null>(null);

  const submit = useCallback(
    async (target: 'sitemap' | 'urls', body: Record<string, unknown>) => {
      setPendingTarget(target);
      try {
        const response = await apiPost<SubmitResponse>('/api/indexation/submit', {
          target,
          websiteId,
          ...body,
        });

        if (isSkipped(response)) {
          toast.warning(response.reason, { description: response.fix, duration: 10_000 });
          return;
        }
        if (!response.ok) {
          toast.error('Bing rejected the submission', { description: response.error, duration: 10_000 });
          return;
        }
        toast.success(
          target === 'sitemap'
            ? 'Sitemap submitted to Bing'
            : `${formatNumber(response.submitted ?? 0)} URL(s) submitted to Bing`,
          {
            description:
              'Submission asks Bing to look sooner. It is a request, not a guarantee of indexing — the page still has to qualify.',
          },
        );
        if (target === 'urls') setUrls('');
      } catch (error) {
        toast.error(error instanceof ApiError ? error.message : 'Could not submit to Bing.');
      } finally {
        setPendingTarget(null);
      }
    },
    [websiteId],
  );

  const urlList = urls
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Send aria-hidden="true" className="size-4 text-muted-foreground" />
          Submit to a search engine
        </CardTitle>
        <CardDescription>
          Bing Webmaster Tools accepts sitemap and URL submissions through its API. Google does not:
          its Indexing API is restricted to job postings and broadcast events, so there is no
          supported way for any tool to push an ordinary page into Google&apos;s index.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {!bing.configured ? (
          <Alert variant="neutral" title="Bing Webmaster Tools is not configured">
            Set <code className="rounded bg-muted px-1 py-0.5 font-mono text-2xs text-foreground">BING_API_KEY</code>{' '}
            on the server and verify this site in Bing Webmaster Tools with the same account. Without
            it there is nowhere to submit — and no Google equivalent exists to fall back on.
          </Alert>
        ) : (
          <>
            {bing.siteUrl ? (
              <p className="text-2xs text-muted-foreground">
                Submitting as the verified Bing property{' '}
                <span className="font-mono text-foreground">{bing.siteUrl}</span>
                {bing.status ? ` · integration ${bing.status.toLowerCase()}` : ''}.
              </p>
            ) : (
              <p className="text-2xs text-muted-foreground">
                The verified Bing property is resolved from your account on first use. If none matches{' '}
                {siteOrigin}, the submission is refused with that reason rather than failing silently.
              </p>
            )}

            <div className="grid gap-4 lg:grid-cols-2">
              <FormField
                label="Sitemap URL"
                description="Tells Bing to re-read the file. Must be on this site's own domain."
              >
                <div className="flex gap-2">
                  <Input
                    value={feedUrl}
                    onChange={(event) => setFeedUrl(event.target.value)}
                    placeholder={`${siteOrigin}/sitemap.xml`}
                    autoComplete="off"
                    inputMode="url"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    loading={pendingTarget === 'sitemap'}
                    loadingText="Submitting"
                    disabled={feedUrl.trim().length === 0}
                    onClick={() => void submit('sitemap', { feedUrl: feedUrl.trim() })}
                  >
                    Submit sitemap
                  </Button>
                </div>
              </FormField>

              <FormField
                label="Individual URLs"
                description={`One per line, up to ${formatNumber(MAX_URLS)} per submission. URLs outside this domain are refused before they leave the server.`}
              >
                <Textarea
                  value={urls}
                  onChange={(event) => setUrls(event.target.value)}
                  rows={4}
                  placeholder={`${siteOrigin}/pricing\n${siteOrigin}/blog/new-post`}
                  className="font-mono text-2xs"
                />
              </FormField>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-2xs text-muted-foreground">
                {urlList.length === 0
                  ? 'No URLs entered.'
                  : `${formatNumber(urlList.length)} URL(s) ready${
                      urlList.length > MAX_URLS ? ` — only the first ${formatNumber(MAX_URLS)} are accepted` : ''
                    }.`}
              </p>
              <Button
                size="sm"
                loading={pendingTarget === 'urls'}
                loadingText="Submitting"
                disabled={urlList.length === 0}
                onClick={() => void submit('urls', { urls: urlList.slice(0, MAX_URLS) })}
              >
                Submit URLs
              </Button>
            </div>
          </>
        )}

        {sitemapDocuments.length > 1 ? (
          <details className="rounded-md border border-border bg-muted/30 p-3">
            <summary className="cursor-pointer text-xs font-medium text-foreground">
              {formatNumber(sitemapDocuments.length)} sitemap documents were fetched by the last crawl
            </summary>
            <ul className="mt-2 space-y-0.5">
              {sitemapDocuments.map((document) => (
                <li key={document} className="truncate font-mono text-2xs text-muted-foreground">
                  {document}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}
