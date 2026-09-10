import Link from 'next/link';
import { Braces, CircleAlert, CircleCheck, ScanLine } from 'lucide-react';
import type { StructuredDataBlock } from '@seo/shared';

import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { formatNumber } from '@/lib/utils';
import type { PageProfile } from '@/server/queries/pages';

/**
 * Structured data on this URL.
 *
 * Two distinct things are shown and never conflated: the JSON-LD the crawler actually found in
 * the HTML, and the markup this platform has generated for the page but not necessarily
 * deployed. A page can have plenty of the second and none of the first.
 */

type GeneratedSchemaItem = PageProfile['recommendations']['structuredData'][number];

export interface PageSchemaPanelProps {
  websiteId: string;
  /** Types the last analysis recorded on the `Page` row — the denormalised summary. */
  schemaTypes: string[];
  /** Blocks the crawler parsed out of the page, with the parser's verdict. */
  blocks: StructuredDataBlock[];
  generated: GeneratedSchemaItem[];
  hasCrawl: boolean;
}

/** Pretty-print for display and for the clipboard. Unparseable values fall back to their text. */
function formatJson(raw: unknown): string {
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

function blockLabel(block: StructuredDataBlock, index: number): string {
  const types = block.type.filter((entry) => entry.trim() !== '');
  return types.length > 0 ? types.join(', ') : `Untyped block ${index + 1}`;
}

function SchemaBlock({ block, index }: { block: StructuredDataBlock; index: number }): React.JSX.Element {
  const json = formatJson(block.raw);
  const errors = block.errors ?? [];

  return (
    <li className="space-y-2 border-b border-border/70 px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {block.valid ? (
          <CircleCheck className="size-3.5 shrink-0 text-success" aria-hidden="true" />
        ) : (
          <CircleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
        )}
        <h4 className="min-w-0 flex-1 font-mono text-xs font-semibold text-foreground">
          {blockLabel(block, index)}
        </h4>
        <Badge variant={block.valid ? 'success' : 'destructive'}>{block.valid ? 'Valid' : 'Invalid'}</Badge>
        <CopyButton value={json} label={`Copy the ${blockLabel(block, index)} JSON-LD`} className="-my-1" />
      </div>

      {errors.length > 0 ? (
        <ul className="space-y-0.5 rounded-md border border-destructive/25 bg-destructive/5 px-2.5 py-1.5">
          {errors.map((error) => (
            <li key={error} className="text-2xs leading-relaxed text-destructive">
              {error}
            </li>
          ))}
        </ul>
      ) : null}

      <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-2.5 text-2xs leading-relaxed text-foreground">
        <code>{json}</code>
      </pre>
    </li>
  );
}

export function PageSchemaPanel({
  websiteId,
  schemaTypes,
  blocks,
  generated,
  hasCrawl,
}: PageSchemaPanelProps): React.JSX.Element {
  const invalid = blocks.filter((block) => !block.valid).length;
  const undeployed = generated.filter((item) => item.deploymentStatus !== 'DEPLOYED');

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Structured data
          {blocks.length > 0 ? <Badge variant="outline">{formatNumber(blocks.length)}</Badge> : null}
          {invalid > 0 ? <Badge variant="destructive">{formatNumber(invalid)} invalid</Badge> : null}
        </CardTitle>
        <CardDescription>
          JSON-LD found in this page&rsquo;s HTML by the last crawl, and the markup this platform holds for the
          URL.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex-1 space-y-4 px-0 pb-0">
        <section aria-labelledby="page-schema-onpage">
          <h4 id="page-schema-onpage" className="px-5 pb-2 text-xs font-semibold text-foreground">
            On the page
          </h4>

          {blocks.length === 0 ? (
            <div className="px-5">
              <EmptyState
                size="sm"
                icon={hasCrawl ? Braces : ScanLine}
                title={hasCrawl ? 'No JSON-LD on this page' : 'No crawl to read markup from'}
                description={
                  hasCrawl
                    ? 'The crawler parsed the HTML and found no schema.org blocks. Without them an answer engine has to infer every fact from prose.'
                    : 'Structured-data blocks are captured while crawling. Run a crawl and whatever the page carries appears here verbatim.'
                }
                action={
                  <Button asChild size="sm" variant="outline">
                    <Link href={hasCrawl ? `/sites/${websiteId}/schema` : `/sites/${websiteId}`}>
                      {hasCrawl ? 'Generate structured data' : 'Start a crawl'}
                    </Link>
                  </Button>
                }
              />
            </div>
          ) : (
            <ul>
              {blocks.map((block, index) => (
                <SchemaBlock key={`${blockLabel(block, index)}-${index}`} block={block} index={index} />
              ))}
            </ul>
          )}

          {blocks.length === 0 && schemaTypes.length > 0 ? (
            <p className="flex flex-wrap items-center gap-1.5 px-5 pt-3 text-2xs text-muted-foreground">
              The last analysis recorded these types on this URL:
              {schemaTypes.map((type) => (
                <Badge key={type} variant="outline">
                  {type}
                </Badge>
              ))}
              <TooltipInfo
                content="These come from the analysis pipeline's summary of an earlier crawl. The blocks themselves were not captured in the crawl this screen reads, so re-crawl to see the markup itself."
                label="Where these types come from"
              />
            </p>
          ) : null}
        </section>

        <section aria-labelledby="page-schema-generated" className="border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-2 px-5 pb-2">
            <h4 id="page-schema-generated" className="text-xs font-semibold text-foreground">
              Generated by the schema agent
            </h4>
            <TooltipInfo
              content="Markup the schema agent produced for this URL from facts visibly present on the page. Generated is not live: an item only affects search results once it is deployed to the site."
              label="What generated structured data means"
            />
          </div>

          {generated.length === 0 ? (
            <p className="px-5 pb-5 text-xs leading-relaxed text-muted-foreground">
              Nothing generated for this URL yet. Run the structured-data agent from{' '}
              <Link href={`/sites/${websiteId}/schema`} className="font-medium text-primary hover:underline">
                Structured data
              </Link>{' '}
              to propose markup for the page type.
            </p>
          ) : (
            <>
              <ul className="px-5 pb-3">
                {generated.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/70 py-2 last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 font-mono text-xs text-foreground">{item.schemaType}</span>
                    <StatusBadge status={item.validationStatus} />
                    <StatusBadge status={item.deploymentStatus} />
                  </li>
                ))}
              </ul>
              {undeployed.length > 0 ? (
                <p className="px-5 pb-5 text-2xs text-muted-foreground">
                  {formatNumber(undeployed.length)} of {formatNumber(generated.length)} not deployed —{' '}
                  <Link href={`/sites/${websiteId}/schema`} className="font-medium text-primary hover:underline">
                    review and deploy
                  </Link>
                  .
                </p>
              ) : null}
            </>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
