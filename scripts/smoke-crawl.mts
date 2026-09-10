/**
 * Development smoke test: crawl a real, public URL and run the technical audit over the result.
 *
 * Touches no database and no API keys — it exercises the crawler and the rules engine end to end.
 *
 *   npx tsx scripts/smoke-crawl.mts https://example.com
 *   SAMPLE_CRAWL_URL=https://example.com npx tsx scripts/smoke-crawl.mts
 */
import { crawlWebsite } from '../packages/crawler/src/index';
import { runTechnicalAudit } from '../packages/seo-engine/src/index';
import type { AuditDataset, AuditPage } from '../packages/seo-engine/src/types';
import { calculateHealthScore } from '../packages/seo-engine/src/scoring/health';
import { normalizeUrl } from '../packages/shared/src/index';

const target = process.argv[2] ?? process.env.SAMPLE_CRAWL_URL ?? 'https://example.com';
const maxPages = Number(process.argv[3] ?? 25);

let parsed: URL;
try {
  parsed = new URL(target);
} catch {
  console.error(`Not a valid URL: ${target}`);
  process.exit(1);
}
const domain = parsed.hostname.replace(/^www\./, '');
const protocol = parsed.protocol.replace(':', '');

console.log(`Crawling ${target} (max ${maxPages} pages)…\n`);

const outcome = await crawlWebsite(
  {
    startUrl: target,
    domain,
    maxPages,
    maxDepth: 3,
    concurrency: 3,
    delayMs: 300,
    respectRobots: true,
    renderJs: false,
    timeoutMs: 20_000,
  },
  {
    onProgress: (progress) =>
      process.stdout.write(`\r  ${progress.processed}/${progress.total} ${progress.message ?? ''}`.padEnd(90)),
  },
);

console.log('\n\n── CRAWL ────────────────────────────────────────────');
console.log(`pages crawled   ${outcome.pages.length}`);
console.log(`internal edges  ${outcome.linkGraph.filter((e) => e.isInternal).length}`);
console.log(`skipped         ${outcome.skipped.length}`);
console.log(`robots.txt      ${outcome.robots.found ? 'found' : 'not found'}`);
console.log(`sitemap         ${outcome.sitemap.sitemapUrls.length} document(s), ${outcome.sitemap.entries.length} URL(s)`);
console.log(`CMS             ${outcome.cms ? `${outcome.cms.cms} (${Math.round(outcome.cms.confidence * 100)}%)` : 'undetected'}`);
console.log(`duration        ${(outcome.durationMs / 1000).toFixed(1)}s`);
if (outcome.warnings.length) console.log(`warnings        ${outcome.warnings.join('; ')}`);

for (const page of outcome.pages.slice(0, 5)) {
  console.log(`\n  ${page.url}`);
  console.log(`    ${page.statusCode} · ${page.wordCount} words · depth ${page.depth} · ${page.isIndexable ? 'indexable' : `not indexable (${page.indexabilityReason})`}`);
  console.log(`    title: ${page.title ? JSON.stringify(page.title.slice(0, 72)) : '(none)'}`);
  console.log(`    h1: ${JSON.stringify(page.h1.slice(0, 2))} · ${page.links.length} links · ${page.images.length} images · schema: ${page.schemaTypes.join(', ') || 'none'}`);
}

const sitemapUrls = new Set(
  outcome.sitemap.entries.map((entry) => normalizeUrl(entry.loc)).filter((u): u is string => Boolean(u)),
);

const auditPages: AuditPage[] = outcome.pages.map((page) => ({
  url: page.url,
  normalizedUrl: page.normalizedUrl,
  statusCode: page.statusCode,
  contentType: page.contentType,
  redirectTarget: page.redirectTarget,
  redirectChain: page.redirectChain,
  depth: page.depth,
  responseTimeMs: page.responseTimeMs,
  contentBytes: page.contentBytes,
  error: page.error,
  title: page.title,
  metaDescription: page.metaDescription,
  canonicalUrl: page.canonicalUrl,
  robotsMeta: page.robotsMeta,
  xRobotsTag: page.xRobotsTag,
  metaViewport: page.metaViewport,
  lang: page.lang,
  h1: page.h1,
  headings: page.headings,
  wordCount: page.wordCount,
  textContent: page.textContent,
  contentHash: page.contentHash,
  simhash: page.simhash,
  links: page.links,
  images: page.images,
  imagesMissingAlt: page.imagesMissingAlt,
  schemaTypes: page.schemaTypes,
  structuredData: page.structuredData,
  hreflang: page.hreflang,
  isIndexable: page.isIndexable,
  indexabilityReason: page.indexabilityReason,
  inSitemap: sitemapUrls.has(page.normalizedUrl),
}));

const dataset: AuditDataset = {
  websiteId: 'smoke-test',
  domain,
  protocol,
  pages: auditPages,
  edges: outcome.linkGraph
    .filter((edge) => edge.isInternal)
    .map((edge) => ({
      from: edge.sourceNormalizedUrl,
      to: edge.normalizedTarget,
      anchorText: edge.anchorText,
      isNofollow: edge.isNofollow,
      inMainContent: edge.inMainContent,
    })),
  robots: {
    found: outcome.robots.found,
    body: outcome.robots.body,
    sitemaps: outcome.robots.sitemaps,
    disallowedUrls: outcome.skipped
      .filter((skip) => skip.reason === 'robots-disallow')
      .map((skip) => skip.normalizedUrl ?? skip.url),
  },
  sitemap: {
    found: outcome.sitemap.sitemapUrls.length > 0,
    urls: outcome.sitemap.entries.map((entry) => entry.loc),
    errors: outcome.sitemap.errors.map((error) => `${error.url}: ${error.error}`),
  },
  settings: { thinContentWords: 300, maxDepthWarn: 4 },
  skipped: outcome.skipped.map((skip) => ({ url: skip.url, reason: `${skip.reason}: ${skip.detail}` })),
};

const audit = runTechnicalAudit(dataset);
const health = calculateHealthScore({ issues: audit.issues, pageCount: audit.stats.pagesAudited });

console.log('\n── AUDIT ────────────────────────────────────────────');
console.log(`health score    ${health.score}/100`);
console.log(`issues          ${audit.issues.length} ${JSON.stringify(audit.stats.issuesBySeverity)}`);
console.log(`orphan pages    ${audit.stats.orphanPages}`);
console.log(`broken pages    ${audit.stats.brokenPages}`);

console.log('\n  Top findings:');
for (const issue of audit.issues.slice(0, 10)) {
  console.log(`   [${issue.severity.padEnd(8)}] ${issue.ruleId}`);
  console.log(`      ${issue.description.slice(0, 120)}`);
}

console.log('\n  Health breakdown:');
for (const factor of health.factors.slice(0, 6)) {
  console.log(`   ${factor.label.padEnd(18)} ${String(Math.round(factor.value * 100)).padStart(3)}/100  (weight ${factor.weight})  ${factor.explanation}`);
}
console.log('');
