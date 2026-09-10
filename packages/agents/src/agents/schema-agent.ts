import { type SchemaValidationStatus, json, prisma } from '@seo/db';
import {
  generateSchemaForPage,
  validateJsonLd,
  type GeneratedSchema,
  type SchemaGenerationContext,
  type SchemaPageInput,
} from '@seo/seo-engine';
import { clamp, round, saturate, truncate } from '@seo/shared';
import { registerAgent } from '../runtime/registry';
import type { AgentContext, AgentDefinition, AgentResult } from '../types';
import {
  ActionCollector,
  NO_CRAWL,
  jsonArray,
  latestCrawl,
  loadSite,
  pluralise,
  propose,
  result,
  skipped,
  step,
  throwIfAborted,
  unique,
} from './shared';

const AGENT = 'SchemaAgent' as const;
const ALLOWED_ACTION_TYPES = ['ADD_STRUCTURED_DATA'] as const;

const DEFAULT_PAGE_LIMIT = 100;
const MAX_ACTIONS = 25;

/** Types the platform never generates from analysis, because they must describe real records. */
const NEVER_GENERATED = new Set(['Review', 'AggregateRating']);

function validationStatusOf(schema: GeneratedSchema): SchemaValidationStatus {
  const status = schema.validation.status;
  return status === 'VALID' || status === 'WARNING' || status === 'INVALID' ? status : 'UNVALIDATED';
}

/**
 * Impact of marking up a page: structured data helps machines read a page that already earns
 * impressions far more than one nobody sees, so demand carries most of the weight.
 */
export function schemaImpact(impressions28d: number, maxImpressions: number, missingTypes: number): number {
  const demand = maxImpressions > 0 ? impressions28d / maxImpressions : 0;
  return round(clamp(demand * 0.6 + saturate(missingTypes, 2) * 0.4), 3);
}

async function run(ctx: AgentContext): Promise<AgentResult> {
  const site = await loadSite(ctx.websiteId);
  const crawl = await step(ctx, 'get_latest_crawl', { websiteId: ctx.websiteId }, () => latestCrawl(ctx.websiteId));
  if (!crawl) return skipped('No crawl to read structured data from.', NO_CRAWL);

  const limit =
    typeof ctx.input.limit === 'number' ? Math.max(1, Math.min(500, ctx.input.limit)) : DEFAULT_PAGE_LIMIT;

  // Pages worth marking up first: no schema at all, or schema the validator rejected.
  const invalidPageIds = await prisma.structuredDataItem
    .findMany({
      where: { websiteId: ctx.websiteId, validationStatus: 'INVALID', pageId: { not: null } },
      select: { pageId: true },
      distinct: ['pageId'],
      take: 500,
    })
    .then((rows) => rows.flatMap((row) => (row.pageId ? [row.pageId] : [])));

  const pages = await step(
    ctx,
    'list_pages_missing_schema',
    { limit },
    () =>
      prisma.page.findMany({
        where: {
          websiteId: ctx.websiteId,
          isActive: true,
          isIndexable: true,
          OR: [{ schemaTypes: { isEmpty: true } }, { id: { in: invalidPageIds } }],
        },
        orderBy: { impressions28d: 'desc' },
        take: limit,
        select: {
          id: true,
          url: true,
          path: true,
          title: true,
          h1: true,
          metaDescription: true,
          pageType: true,
          schemaTypes: true,
          impressions28d: true,
          publishedAt: true,
          contentUpdatedAt: true,
        },
      }),
    (rows) => ({ pages: rows.length }),
  );

  if (pages.length === 0) {
    return result({
      summary: `Every indexable page on ${site.domain} already carries structured data that validates.`,
      confidence: 0.85,
      data: { crawlId: crawl.id, pagesNeedingSchema: 0 },
    });
  }

  const crawlPages = await prisma.crawlPage.findMany({
    where: { crawlId: crawl.id, pageId: { in: pages.map((page) => page.id) } },
    select: { pageId: true, textContent: true, headings: true, schemaTypes: true },
  });
  const contentByPageId = new Map(
    crawlPages.flatMap((row) =>
      row.pageId
        ? [
            [
              row.pageId,
              {
                textContent: row.textContent,
                headings: jsonArray(row.headings).flatMap((heading) =>
                  typeof heading.text === 'string' && typeof heading.level === 'number'
                    ? [{ level: heading.level, text: heading.text }]
                    : [],
                ),
                schemaTypes: row.schemaTypes,
              },
            ] as const,
          ]
        : [],
    ),
  );

  const context: SchemaGenerationContext = {
    domain: site.domain,
    protocol: site.protocol,
    brandName: site.brandName,
    siteName: site.name,
    // Only facts we actually hold. A fabricated logo URL or social profile is worse than none.
    logoUrl: null,
    organizationDescription: site.description,
    sameAs: [],
    language: site.primaryLanguage,
  };

  const homepagePath = '/';
  const maxImpressions = Math.max(...pages.map((page) => page.impressions28d), 1);
  const actions = new ActionCollector();
  const declinedFindings: Array<{ url: string; schemaType: string; reason: string }> = [];
  let itemsPersisted = 0;
  let pagesWithSchema = 0;

  for (const page of pages) {
    throwIfAborted(ctx);
    const content = contentByPageId.get(page.id);
    const input: SchemaPageInput = {
      url: page.url,
      path: page.path,
      title: page.title,
      h1: page.h1,
      metaDescription: page.metaDescription,
      textContent: content?.textContent ?? null,
      headings: content?.headings ?? [],
      pageType: page.pageType,
      publishedAt: page.publishedAt,
      contentUpdatedAt: page.contentUpdatedAt,
      existingSchemaTypes: content?.schemaTypes ?? page.schemaTypes,
      // The generator only emits an author when one is genuinely known for the page; we never
      // attach a knowledge-base author to a page that does not name them.
      author: null,
    };

    const generated = generateSchemaForPage(input, context, { isHomepage: page.path === homepagePath });

    for (const declined of generated.declined) {
      declinedFindings.push({ url: page.url, schemaType: declined.schemaType, reason: declined.reason });
    }

    const usable = generated.generated.filter(
      (schema) =>
        !schema.redundant && !NEVER_GENERATED.has(schema.schemaType) && validationStatusOf(schema) !== 'INVALID',
    );
    for (const schema of generated.generated) {
      if (NEVER_GENERATED.has(schema.schemaType)) {
        declinedFindings.push({
          url: page.url,
          schemaType: schema.schemaType,
          reason: 'Review and rating markup must come from real stored reviews, never from page analysis.',
        });
      }
    }
    if (usable.length === 0) continue;
    pagesWithSchema++;

    for (const schema of usable) {
      // Re-validate the exact object being stored: the item in the database is what gets deployed.
      const validation = validateJsonLd(schema.jsonLd);
      await prisma.structuredDataItem.create({
        data: {
          websiteId: ctx.websiteId,
          pageId: page.id,
          schemaType: schema.schemaType,
          jsonLd: json(schema.jsonLd),
          source: 'generated',
          validationStatus: validation.status === 'INVALID' ? 'INVALID' : validation.status === 'WARNING' ? 'WARNING' : 'VALID',
          validationErrors: json(validation.issues),
          deploymentStatus: 'NOT_DEPLOYED',
          notes: schema.reason,
        },
      });
      itemsPersisted++;
    }

    if (actions.actionsCreated.length < MAX_ACTIONS) {
      const types = unique(usable.map((schema) => schema.schemaType));
      await propose(ctx, actions, {
        type: 'ADD_STRUCTURED_DATA',
        title: `Add ${types.join(' + ')} markup to ${truncate(page.url, 70, '…')}`,
        reasoning:
          `${page.url} has ${page.schemaTypes.length === 0 ? 'no structured data' : `structured data that failed validation (${page.schemaTypes.join(', ')})`}. ` +
          `Generated ${types.join(', ')} entirely from properties visible on the page: ${usable.map((schema) => schema.reason).join(' ')} ` +
          'Structured data makes the same facts machine-readable; it does not change what the page says.',
        evidence: {
          pageType: page.pageType,
          existingSchemaTypes: page.schemaTypes,
          generatedTypes: types,
          impressions28d: page.impressions28d,
          validation: usable.map((schema) => ({ type: schema.schemaType, status: schema.validation.status, issues: schema.validation.issues })),
          declined: generated.declined,
        },
        affectedUrls: [page.url],
        payload: {
          pageId: page.id,
          url: page.url,
          jsonLd: usable.map((schema) => schema.jsonLd),
        },
        impact: schemaImpact(page.impressions28d, maxImpressions, types.length),
        confidence: 0.85,
        effort: 1,
        sourceType: 'Page',
        sourceId: `schema:${page.id}:${crawl.id}`,
      });
    }
  }

  return result({
    summary:
      `${pages.length} ${pluralise(pages.length, 'page')} lacked valid structured data. Generated markup for ` +
      `${pagesWithSchema} of them (${itemsPersisted} ${pluralise(itemsPersisted, 'block')}), proposed ${actions.actionsCreated.length} ` +
      `${pluralise(actions.actionsCreated.length, 'action')}. ${declinedFindings.length} ${pluralise(declinedFindings.length, 'type')} declined because the page does not contain the content they would claim.`,
    confidence: 0.85,
    actionsCreated: actions.actionsCreated,
    approvalsCreated: actions.approvalsCreated,
    findings: [
      ...declinedFindings.slice(0, 30).map((entry) => ({ kind: 'schema-declined', ...entry })),
    ],
    data: {
      crawlId: crawl.id,
      pagesEvaluated: pages.length,
      pagesWithGeneratedSchema: pagesWithSchema,
      itemsPersisted,
      declined: declinedFindings.length,
      policy:
        'Every property is derived from content present on the page. FAQPage, Review and AggregateRating are refused ' +
        'unless the underlying content genuinely exists, because marking up content a reader cannot see is a spam ' +
        'policy violation that risks a manual action.',
    },
  });
}

export const schemaAgent: AgentDefinition = {
  name: AGENT,
  label: 'Structured data',
  description:
    'Generates and validates Schema.org JSON-LD for pages missing or mis-marked-up structured data, using only facts visible on the page.',
  allowedActionTypes: [...ALLOWED_ACTION_TYPES],
  tools: ['get_latest_crawl', 'list_pages_missing_schema'],
  requiresAi: false,
  run,
};

registerAgent(schemaAgent);
