import { splitSentences, toAbsolute, truncate } from '@seo/shared';
import { validateJsonLd, type ValidationResult } from './validate';

/**
 * Structured-data generation.
 *
 * Integrity rule enforced throughout: markup is only generated for content that is *actually
 * present on the page*. We never invent FAQs, ratings, prices, authors or dates. Where a required
 * property cannot be sourced from real data, the generator declines to emit that schema type and
 * explains why, rather than emitting misleading markup.
 */

export interface SchemaGenerationContext {
  domain: string;
  protocol: string;
  brandName: string | null;
  siteName: string;
  logoUrl: string | null;
  organizationDescription: string | null;
  sameAs: string[];
  contactEmail?: string | null;
  contactPhone?: string | null;
  address?: {
    streetAddress?: string; addressLocality?: string; addressRegion?: string;
    postalCode?: string; addressCountry?: string;
  } | null;
  language: string;
}

export interface SchemaPageInput {
  url: string;
  path: string;
  title: string | null;
  h1: string | null;
  metaDescription: string | null;
  textContent: string | null;
  html?: string | null;
  headings: Array<{ level: number; text: string }>;
  pageType: string;
  publishedAt: Date | null;
  contentUpdatedAt: Date | null;
  imageUrl?: string | null;
  existingSchemaTypes: string[];
  /** Author known from the page itself or the site knowledge base — never invented. */
  author?: { name: string; url?: string | null; jobTitle?: string | null } | null;
  breadcrumbs?: Array<{ name: string; url: string }>;
}

export interface GeneratedSchema {
  schemaType: string;
  jsonLd: Record<string, unknown>;
  validation: ValidationResult;
  reason: string;
  /** True when the page already has this type and the generated version adds nothing. */
  redundant: boolean;
}

export interface SchemaGenerationResult {
  generated: GeneratedSchema[];
  declined: Array<{ schemaType: string; reason: string }>;
}

const SCHEMA_CONTEXT = 'https://schema.org';

export function generateOrganizationSchema(ctx: SchemaGenerationContext): GeneratedSchema | null {
  if (!ctx.brandName && !ctx.siteName) return null;
  const siteUrl = `${ctx.protocol}://${ctx.domain}`;
  const jsonLd: Record<string, unknown> = {
    '@context': SCHEMA_CONTEXT,
    '@type': 'Organization',
    '@id': `${siteUrl}/#organization`,
    name: ctx.brandName ?? ctx.siteName,
    url: siteUrl,
  };
  if (ctx.logoUrl) jsonLd.logo = { '@type': 'ImageObject', url: ctx.logoUrl };
  if (ctx.organizationDescription) jsonLd.description = ctx.organizationDescription;
  if (ctx.sameAs.length) jsonLd.sameAs = ctx.sameAs;
  if (ctx.contactEmail || ctx.contactPhone) {
    jsonLd.contactPoint = {
      '@type': 'ContactPoint',
      contactType: 'customer support',
      ...(ctx.contactEmail ? { email: ctx.contactEmail } : {}),
      ...(ctx.contactPhone ? { telephone: ctx.contactPhone } : {}),
    };
  }
  if (ctx.address) jsonLd.address = { '@type': 'PostalAddress', ...ctx.address };

  return {
    schemaType: 'Organization',
    jsonLd,
    validation: validateJsonLd(jsonLd),
    reason:
      'Organization markup is the anchor entity that ties this brand to a knowledge-graph record. Answer engines use it ' +
      'to resolve "who is this" before deciding whether to cite the site.',
    redundant: false,
  };
}

export function generateWebSiteSchema(ctx: SchemaGenerationContext, searchUrlTemplate?: string): GeneratedSchema {
  const siteUrl = `${ctx.protocol}://${ctx.domain}`;
  const jsonLd: Record<string, unknown> = {
    '@context': SCHEMA_CONTEXT,
    '@type': 'WebSite',
    '@id': `${siteUrl}/#website`,
    name: ctx.siteName,
    url: siteUrl,
    inLanguage: ctx.language,
    publisher: { '@id': `${siteUrl}/#organization` },
  };
  // Only declare a search action when a real search endpoint was supplied.
  if (searchUrlTemplate) {
    jsonLd.potentialAction = {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: searchUrlTemplate },
      'query-input': 'required name=search_term_string',
    };
  }
  return {
    schemaType: 'WebSite',
    jsonLd,
    validation: validateJsonLd(jsonLd),
    reason: 'WebSite markup names the site as an entity and links every page back to the publishing organization.',
    redundant: false,
  };
}

export function generateBreadcrumbSchema(page: SchemaPageInput, ctx: SchemaGenerationContext): GeneratedSchema | null {
  const crumbs = page.breadcrumbs ?? deriveBreadcrumbsFromPath(page.path, ctx);
  if (crumbs.length < 2) return null;
  const jsonLd = {
    '@context': SCHEMA_CONTEXT,
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: crumb.url,
    })),
  };
  return {
    schemaType: 'BreadcrumbList',
    jsonLd,
    validation: validateJsonLd(jsonLd),
    reason: 'Breadcrumb markup makes the site hierarchy explicit and improves how the URL is presented in results.',
    redundant: page.existingSchemaTypes.includes('BreadcrumbList'),
  };
}

export function generateArticleSchema(
  page: SchemaPageInput,
  ctx: SchemaGenerationContext,
): { schema: GeneratedSchema | null; declined?: { schemaType: string; reason: string } } {
  const headline = page.h1 ?? page.title;
  if (!headline) {
    return { schema: null, declined: { schemaType: 'Article', reason: 'The page has no H1 or title to use as the headline.' } };
  }
  const siteUrl = `${ctx.protocol}://${ctx.domain}`;
  const type = page.pageType === 'ARTICLE' ? 'BlogPosting' : 'Article';

  const jsonLd: Record<string, unknown> = {
    '@context': SCHEMA_CONTEXT,
    '@type': type,
    headline: truncate(headline, 110),
    mainEntityOfPage: { '@type': 'WebPage', '@id': page.url },
    url: page.url,
    inLanguage: ctx.language,
    publisher: { '@id': `${siteUrl}/#organization` },
  };
  if (page.metaDescription) jsonLd.description = page.metaDescription;
  if (page.imageUrl) jsonLd.image = page.imageUrl;

  // Dates only when we genuinely know them — a fabricated datePublished is a trust violation.
  if (page.publishedAt) jsonLd.datePublished = page.publishedAt.toISOString();
  if (page.contentUpdatedAt) jsonLd.dateModified = page.contentUpdatedAt.toISOString();

  // Author only when a real author is known.
  if (page.author?.name) {
    jsonLd.author = {
      '@type': 'Person',
      name: page.author.name,
      ...(page.author.url ? { url: page.author.url } : {}),
      ...(page.author.jobTitle ? { jobTitle: page.author.jobTitle } : {}),
    };
  }

  const validation = validateJsonLd(jsonLd);
  return {
    schema: {
      schemaType: type,
      jsonLd,
      validation,
      reason:
        `${type} markup identifies this page as editorial content with a headline, publisher and (where known) an author ` +
        'and dates. Missing author/date properties are reported as warnings rather than filled in with guesses.',
      redundant: page.existingSchemaTypes.includes(type),
    },
  };
}

/**
 * FAQPage markup — only from question/answer pairs that are genuinely visible on the page.
 * Google requires the content to be visible; inventing Q&A would be both a policy violation and
 * a lie to the reader.
 */
export function generateFaqSchema(
  page: SchemaPageInput,
): { schema: GeneratedSchema | null; declined?: { schemaType: string; reason: string } } {
  const pairs = extractVisibleFaqPairs(page);
  if (pairs.length < 2) {
    return {
      schema: null,
      declined: {
        schemaType: 'FAQPage',
        reason:
          `Only ${pairs.length} genuine question/answer pair(s) are visible on the page. FAQPage markup requires the Q&A to ` +
          'be present in the visible content — the generator will not invent questions.',
      },
    };
  }
  const jsonLd = {
    '@context': SCHEMA_CONTEXT,
    '@type': 'FAQPage',
    mainEntity: pairs.map((pair) => ({
      '@type': 'Question',
      name: pair.question,
      acceptedAnswer: { '@type': 'Answer', text: pair.answer },
    })),
  };
  return {
    schema: {
      schemaType: 'FAQPage',
      jsonLd,
      validation: validateJsonLd(jsonLd),
      reason: `${pairs.length} question/answer pairs were found in the page's visible content and marked up verbatim.`,
      redundant: page.existingSchemaTypes.includes('FAQPage'),
    },
  };
}

export function generateSoftwareApplicationSchema(
  page: SchemaPageInput,
  ctx: SchemaGenerationContext,
  product: { name: string; category: string; operatingSystem?: string; price?: string; currency?: string; description?: string },
): GeneratedSchema {
  const jsonLd: Record<string, unknown> = {
    '@context': SCHEMA_CONTEXT,
    '@type': 'SoftwareApplication',
    name: product.name,
    applicationCategory: product.category,
    url: page.url,
    ...(product.description ? { description: product.description } : {}),
    ...(product.operatingSystem ? { operatingSystem: product.operatingSystem } : {}),
    publisher: { '@id': `${ctx.protocol}://${ctx.domain}/#organization` },
  };
  // Offers only when a real price is supplied. No aggregateRating unless real reviews exist —
  // fabricated ratings are explicitly out of scope for this product.
  if (product.price !== undefined) {
    jsonLd.offers = {
      '@type': 'Offer',
      price: product.price,
      priceCurrency: product.currency ?? 'USD',
    };
  }
  return {
    schemaType: 'SoftwareApplication',
    jsonLd,
    validation: validateJsonLd(jsonLd),
    reason:
      'SoftwareApplication markup states the product category and platform explicitly, which is how answer engines decide ' +
      'whether a product belongs in a "best X" style answer.',
    redundant: page.existingSchemaTypes.includes('SoftwareApplication'),
  };
}

export function generatePersonSchema(
  author: { name: string; url?: string | null; jobTitle?: string | null; bio?: string | null; sameAs?: string[] },
  ctx: SchemaGenerationContext,
): GeneratedSchema {
  const jsonLd: Record<string, unknown> = {
    '@context': SCHEMA_CONTEXT,
    '@type': 'Person',
    name: author.name,
    ...(author.url ? { url: author.url } : {}),
    ...(author.jobTitle ? { jobTitle: author.jobTitle } : {}),
    ...(author.bio ? { description: author.bio } : {}),
    ...(author.sameAs?.length ? { sameAs: author.sameAs } : {}),
    worksFor: { '@id': `${ctx.protocol}://${ctx.domain}/#organization` },
  };
  return {
    schemaType: 'Person',
    jsonLd,
    validation: validateJsonLd(jsonLd),
    reason: 'Person markup makes authorship machine-readable, which is a direct expertise signal for both search and answer engines.',
    redundant: false,
  };
}

/** Choose and generate every schema type appropriate for a page. */
export function generateSchemaForPage(
  page: SchemaPageInput,
  ctx: SchemaGenerationContext,
  options: {
    isHomepage?: boolean;
    product?: { name: string; category: string; operatingSystem?: string; price?: string; currency?: string; description?: string };
    searchUrlTemplate?: string;
  } = {},
): SchemaGenerationResult {
  const generated: GeneratedSchema[] = [];
  const declined: Array<{ schemaType: string; reason: string }> = [];

  if (options.isHomepage) {
    const org = generateOrganizationSchema(ctx);
    if (org) generated.push(org);
    else declined.push({ schemaType: 'Organization', reason: 'No brand or site name configured for this website.' });
    generated.push(generateWebSiteSchema(ctx, options.searchUrlTemplate));
  }

  const breadcrumb = generateBreadcrumbSchema(page, ctx);
  if (breadcrumb) generated.push(breadcrumb);

  if (['ARTICLE', 'BLOG_INDEX'].includes(page.pageType) || (page.pageType === 'OTHER' && page.path.includes('/blog'))) {
    const article = generateArticleSchema(page, ctx);
    if (article.schema) generated.push(article.schema);
    if (article.declined) declined.push(article.declined);
  }

  const faq = generateFaqSchema(page);
  if (faq.schema) generated.push(faq.schema);
  else if (faq.declined && countQuestionHeadings(page) > 0) declined.push(faq.declined);

  if (options.product && ['PRODUCT', 'LANDING', 'HOMEPAGE'].includes(page.pageType)) {
    generated.push(generateSoftwareApplicationSchema(page, ctx, options.product));
  }

  if (page.author?.name && page.pageType === 'AUTHOR') {
    generated.push(generatePersonSchema(page.author, ctx));
  }

  return { generated, declined };
}

/** Derive breadcrumbs from the URL path when the page does not expose its own. */
function deriveBreadcrumbsFromPath(path: string, ctx: SchemaGenerationContext): Array<{ name: string; url: string }> {
  const siteUrl = `${ctx.protocol}://${ctx.domain}`;
  const segments = path.split('/').filter(Boolean);
  const crumbs = [{ name: 'Home', url: `${siteUrl}/` }];
  let accumulated = '';
  for (const segment of segments) {
    accumulated += `/${segment}`;
    crumbs.push({
      name: segment
        .replace(/\.(html?|php|aspx?)$/i, '')
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase()),
      url: toAbsolute(ctx.domain, accumulated, ctx.protocol),
    });
  }
  return crumbs;
}

interface FaqPair { question: string; answer: string }

/**
 * Extract Q&A pairs that are visibly on the page: a question-shaped heading followed by prose.
 * Answers are truncated to a reasonable length and taken verbatim from the page text.
 */
function extractVisibleFaqPairs(page: SchemaPageInput): FaqPair[] {
  const text = page.textContent ?? '';
  if (!text) return [];
  const pairs: FaqPair[] = [];

  const questionHeadings = page.headings.filter(
    (h) => h.level >= 2 && (h.text.trim().endsWith('?') || /^(what|how|why|when|where|who|which|can|does|do|is|are)\b/i.test(h.text.trim())),
  );

  for (const heading of questionHeadings) {
    const index = text.indexOf(heading.text);
    if (index === -1) continue;
    const after = text.slice(index + heading.text.length).trim();
    if (!after) continue;
    // Stop at the next heading so the answer does not swallow the following section.
    let answerText = after;
    for (const other of page.headings) {
      if (other === heading) continue;
      const nextIndex = answerText.indexOf(other.text);
      if (nextIndex > 0 && nextIndex < 1200) answerText = answerText.slice(0, nextIndex);
    }
    const sentences = splitSentences(answerText).slice(0, 4).join(' ').trim();
    if (sentences.length < 40) continue;
    pairs.push({ question: heading.text.trim(), answer: truncate(sentences, 800) });
  }
  return pairs.slice(0, 12);
}

function countQuestionHeadings(page: SchemaPageInput): number {
  return page.headings.filter((h) => h.text.trim().endsWith('?')).length;
}

/** Serialise a JSON-LD object into the exact <script> tag to paste into a page. */
export function toScriptTag(jsonLd: Record<string, unknown>): string {
  // Escaping </script> inside the payload is required or the tag terminates early.
  const json = JSON.stringify(jsonLd, null, 2).replace(/<\/script/gi, '<\\/script');
  return `<script type="application/ld+json">\n${json}\n</script>`;
}
