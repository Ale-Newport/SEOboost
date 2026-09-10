import { AlignLeft, BookOpen, Heading1, ImageOff, ListTree, ScanLine, Type } from 'lucide-react';
import Link from 'next/link';
import { SEO_THRESHOLDS, type HeadingNode } from '@seo/shared';
import type { Page } from '@seo/db';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { cn, formatNumber } from '@/lib/utils';
import type { MetaField, MetaReview, PageDocument } from '@/components/pages/types';

/**
 * What the page actually says, measured against the thresholds the audit uses.
 *
 * Every number here is a count of something the crawler recorded — characters, headings, words,
 * images without alt text. Nothing is modelled, so an empty panel means the crawl has not run
 * rather than that the page is fine.
 */

export interface PageContentPanelProps {
  page: Page;
  document: PageDocument | null;
  meta: MetaReview;
  /** The site's own thin-content threshold, which overrides the shared default. */
  thinContentWords: number;
}

const STATUS_META: Record<MetaField['status'], { label: string; tone: 'success' | 'warning' | 'destructive'; bar: string }> = {
  ok: { label: 'In range', tone: 'success', bar: 'bg-success' },
  short: { label: 'Too short', tone: 'warning', bar: 'bg-warning' },
  long: { label: 'Too long', tone: 'warning', bar: 'bg-warning' },
  missing: { label: 'Missing', tone: 'destructive', bar: 'bg-destructive' },
};

interface MetaMeterProps {
  label: string;
  icon: typeof Type;
  field: MetaField;
  /** The length at which Google reliably truncates — the end of the scale. */
  hardMax: number;
  info: string;
  missingHint: string;
}

/**
 * One length meter.
 *
 * The bar is scaled to the truncation limit rather than to the value, so a 92-character title
 * visibly overruns the end of the track instead of being silently normalised back inside it.
 */
function MetaMeter({ label, icon: Icon, field, hardMax, info, missingHint }: MetaMeterProps): React.JSX.Element {
  const status = STATUS_META[field.status];
  const scale = Math.max(hardMax, field.length);
  const pct = (value: number): string => `${Math.min(100, (value / scale) * 100)}%`;

  return (
    <section className="space-y-2" aria-label={label}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h4 className="text-xs font-semibold text-foreground">{label}</h4>
        <Badge variant={status.tone}>{status.label}</Badge>
        <TooltipInfo content={info} label={`How ${label.toLowerCase()} length is judged`} />
        <span className="ml-auto tabular text-2xs text-muted-foreground">
          {field.length} / {field.min}–{field.max} chars
        </span>
      </div>

      {field.value === null ? (
        <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          {missingHint}
        </p>
      ) : (
        <div className="flex items-start gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-2">
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-foreground">{field.value}</p>
          <CopyButton value={field.value} label={`Copy the ${label.toLowerCase()}`} className="-my-1 -mr-1.5" />
        </div>
      )}

      <div className="relative h-2 w-full rounded-full bg-muted" aria-hidden="true">
        <div
          className="absolute inset-y-0 rounded-full bg-success/20"
          style={{ left: pct(field.min), right: `${Math.max(0, 100 - (field.max / scale) * 100)}%` }}
        />
        <div className={cn('absolute inset-y-0 left-0 rounded-full opacity-80', status.bar)} style={{ width: pct(field.length) }} />
        <span className="absolute -inset-y-1 w-px bg-border" style={{ left: pct(hardMax) }} />
      </div>
      <p className="text-2xs leading-relaxed text-muted-foreground">
        Recommended {field.min}–{field.max} characters; search results truncate past {hardMax}.
      </p>
    </section>
  );
}

/** A heading whose level is more than one step below the heading above it — a broken outline. */
function outlineProblems(headings: readonly HeadingNode[]): { h1Count: number; skips: number; empty: number } {
  let h1Count = 0;
  let skips = 0;
  let empty = 0;
  let previous = 0;

  for (const heading of headings) {
    if (heading.level === 1) h1Count += 1;
    if (heading.text.trim() === '') empty += 1;
    if (previous > 0 && heading.level > previous + 1) skips += 1;
    previous = heading.level;
  }
  return { h1Count, skips, empty };
}

function contentDepthLabel(words: number, thin: number): { label: string; tone: 'success' | 'warning' | 'destructive' } {
  if (words < thin) return { label: 'Thin', tone: 'destructive' };
  if (words < SEO_THRESHOLDS.content.shallow) return { label: 'Shallow', tone: 'warning' };
  if (words < SEO_THRESHOLDS.content.healthy) return { label: 'Adequate', tone: 'warning' };
  return { label: 'Healthy', tone: 'success' };
}

export function PageContentPanel({
  page,
  document,
  meta,
  thinContentWords,
}: PageContentPanelProps): React.JSX.Element {
  const headings = document?.headings ?? [];
  const outline = outlineProblems(headings);
  const depth = contentDepthLabel(page.wordCount, thinContentWords);

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>Content &amp; metadata</CardTitle>
        <CardDescription>
          Measured against the thresholds the technical audit applies. Character counts are of the text as
          crawled, not as rendered.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex-1 space-y-5">
        <MetaMeter
          label="Title"
          icon={Type}
          field={meta.title}
          hardMax={SEO_THRESHOLDS.title.hardMax}
          info="The title tag is the strongest on-page relevance signal and the line a searcher clicks. Below the minimum it wastes the slot; above it Google rewrites or truncates it."
          missingHint="No title tag was found on this page. Search results will fall back to the H1 or the URL."
        />

        <MetaMeter
          label="Meta description"
          icon={AlignLeft}
          field={meta.metaDescription}
          hardMax={SEO_THRESHOLDS.metaDescription.hardMax}
          info="Not a ranking factor, but it is the snippet that earns the click. Without one, Google assembles the snippet from whatever body text matches the query."
          missingHint="No meta description. The snippet will be assembled from body text, which rarely matches the intent behind the query."
        />

        <section className="space-y-2" aria-label="H1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Heading1 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <h4 className="text-xs font-semibold text-foreground">H1</h4>
            {meta.h1 === null ? (
              <Badge variant="warning">Missing</Badge>
            ) : outline.h1Count > SEO_THRESHOLDS.h1.max ? (
              <Badge variant="warning">{outline.h1Count} on the page</Badge>
            ) : (
              <Badge variant="success">Present</Badge>
            )}
            <TooltipInfo
              content={`One H1 per page. It states what the page is about to both readers and parsers; more than ${SEO_THRESHOLDS.h1.max} makes that ambiguous.`}
              label="How the H1 is judged"
            />
            {meta.h1 === null ? null : (
              <span className="ml-auto tabular text-2xs text-muted-foreground">{meta.h1.length} chars</span>
            )}
          </div>
          {meta.h1 === null ? (
            <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              The crawl found no H1. Add one that states the page&rsquo;s subject in the searcher&rsquo;s words.
            </p>
          ) : (
            <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-foreground">
              {meta.h1}
            </p>
          )}
        </section>

        <section className="space-y-2" aria-labelledby="page-content-stats">
          <h4 id="page-content-stats" className="text-xs font-semibold text-foreground">
            Body
          </h4>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-md border border-border px-3 py-2">
              <dt className="flex items-center gap-1 text-2xs uppercase tracking-wide text-muted-foreground">
                Words
                <TooltipInfo
                  content={`Words in the main content the crawler extracted. This site treats anything under ${formatNumber(thinContentWords)} words as thin; the shared bands are ${SEO_THRESHOLDS.content.shallow} for shallow and ${SEO_THRESHOLDS.content.healthy} for healthy.`}
                  label="How the word count is banded"
                />
              </dt>
              <dd className="mt-0.5 flex items-baseline gap-1.5">
                <span className="tabular text-sm font-semibold text-foreground">{formatNumber(page.wordCount)}</span>
                <Badge variant={depth.tone}>{depth.label}</Badge>
              </dd>
            </div>

            <div className="rounded-md border border-border px-3 py-2">
              <dt className="flex items-center gap-1 text-2xs uppercase tracking-wide text-muted-foreground">
                <BookOpen className="size-3" aria-hidden="true" />
                Readability
                <TooltipInfo
                  content="Flesch reading ease over the extracted main content: 0–100, higher is easier. 60–70 is plain English; the page score only stops nudging content down between 45 and 80."
                  label="How readability is measured"
                />
              </dt>
              <dd className="mt-0.5 text-sm font-semibold text-foreground">
                {document?.readability ? (
                  <span className="flex items-baseline gap-1.5">
                    <span className="tabular">{Math.round(document.readability.score)}</span>
                    <span className="text-2xs font-normal text-muted-foreground">{document.readability.label}</span>
                  </span>
                ) : (
                  <span className="text-xs font-normal text-muted-foreground">Not measured</span>
                )}
              </dd>
            </div>

            <div className="rounded-md border border-border px-3 py-2">
              <dt className="flex items-center gap-1 text-2xs uppercase tracking-wide text-muted-foreground">
                <ListTree className="size-3" aria-hidden="true" />
                Headings
              </dt>
              <dd className="mt-0.5 tabular text-sm font-semibold text-foreground">
                {document ? formatNumber(headings.length) : <span className="text-xs font-normal text-muted-foreground">—</span>}
              </dd>
            </div>

            <div className="rounded-md border border-border px-3 py-2">
              <dt className="flex items-center gap-1 text-2xs uppercase tracking-wide text-muted-foreground">
                <ImageOff className="size-3" aria-hidden="true" />
                Alt missing
              </dt>
              <dd className="mt-0.5 flex items-baseline gap-1.5">
                {document ? (
                  <>
                    <span
                      className={cn(
                        'tabular text-sm font-semibold',
                        document.imagesMissingAlt > 0 ? 'text-warning' : 'text-foreground',
                      )}
                    >
                      {formatNumber(document.imagesMissingAlt)}
                    </span>
                    <span className="text-2xs text-muted-foreground">of {formatNumber(document.imageCount)}</span>
                  </>
                ) : (
                  <span className="text-xs font-normal text-muted-foreground">—</span>
                )}
              </dd>
            </div>
          </dl>
        </section>

        <section className="space-y-2" aria-labelledby="page-heading-outline">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4 id="page-heading-outline" className="text-xs font-semibold text-foreground">
              Heading outline
            </h4>
            {outline.skips > 0 ? (
              <Badge variant="warning">
                {outline.skips} skipped level{outline.skips === 1 ? '' : 's'}
              </Badge>
            ) : null}
            {outline.empty > 0 ? (
              <Badge variant="warning">
                {outline.empty} empty heading{outline.empty === 1 ? '' : 's'}
              </Badge>
            ) : null}
          </div>

          {headings.length === 0 ? (
            <EmptyState
              size="sm"
              icon={ScanLine}
              title={document ? 'No headings on this page' : 'No crawl document for this URL'}
              description={
                document
                  ? 'The crawl parsed this page and found no H1–H6 elements at all. Readers and answer engines both use the outline to navigate — add one.'
                  : 'The heading outline, image counts and readability all come from the crawled HTML. Start a crawl from the site overview to capture them.'
              }
              action={
                document ? null : (
                  <Link
                    href={`/sites/${page.websiteId}`}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    Go to the site overview
                  </Link>
                )
              }
            />
          ) : (
            <ol className="space-y-1">
              {headings.map((heading, index) => (
                <li
                  key={`${heading.level}-${index}-${heading.text.slice(0, 32)}`}
                  className="flex items-baseline gap-2 text-xs leading-relaxed"
                  style={{ paddingLeft: `${Math.max(0, heading.level - 1) * 0.75}rem` }}
                >
                  <span className="tabular shrink-0 rounded border border-border px-1 text-2xs font-medium text-muted-foreground">
                    H{heading.level}
                  </span>
                  <span className={cn('min-w-0 break-words', heading.text.trim() === '' ? 'italic text-warning' : 'text-foreground')}>
                    {heading.text.trim() === '' ? 'Empty heading' : heading.text}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
