import { createLogger, normalizeUrl } from '@seo/shared';
import { prisma } from '../client';
import { createManyChunked, json } from '../helpers';
import { persistDemoActions } from './demo-actions';
import { persistDemoCrawl } from './demo-crawl';
import { persistDemoInsights } from './demo-insights';
import { buildDemoMetrics } from './demo-metrics';
import { buildDemoCrawl } from './demo-pages';
import { DEMO_NAME_PREFIX, DEMO_SITES, type DemoSiteBlueprint } from './demo-sites';
import { persistDemoSearchData } from './demo-search';
import type { DemoSiteSummary } from './types';

const log = createLogger('seed:demo');

/**
 * Delete every demo website. Cascades take care of the ~20 dependent tables, which is why demo
 * data is anchored on `Website.isDemo` and never scattered across unrelated rows.
 */
export async function clearDemoData(): Promise<{ websites: number; names: string[] }> {
  const demoSites = await prisma.website.findMany({ where: { isDemo: true }, select: { id: true, name: true } });
  if (demoSites.length === 0) return { websites: 0, names: [] };

  const result = await prisma.website.deleteMany({ where: { isDemo: true } });
  log.info('demo data cleared', { websites: result.count });
  return { websites: result.count, names: demoSites.map((site) => site.name) };
}

export interface DemoSeedResult {
  sites: DemoSiteSummary[];
  skipped: Array<{ domain: string; reason: string }>;
  experiments: string[];
}

/**
 * Build the whole demo dataset.
 *
 * Any existing demo data is removed first: re-running the seed must converge on the same state
 * rather than layering a second copy on top, and the generators are deterministic, so the second
 * run produces the same numbers as the first.
 */
export async function seedDemoData(userId: string, now: Date): Promise<DemoSeedResult> {
  await clearDemoData();

  const sites: DemoSiteSummary[] = [];
  const skipped: Array<{ domain: string; reason: string }> = [];
  const experiments: string[] = [];

  for (const [index, blueprint] of DEMO_SITES.entries()) {
    const existing = await prisma.website.findUnique({
      where: { userId_domain: { userId, domain: blueprint.domain } },
      select: { id: true, isDemo: true },
    });
    if (existing && !existing.isDemo) {
      // Refusing here is deliberate: silently converting a real website row into a demo one would
      // be the worst possible outcome of running a seed.
      skipped.push({ domain: blueprint.domain, reason: 'a non-demo website already uses this domain' });
      continue;
    }

    const summary = await seedDemoSite(blueprint, userId, now, index === 0);
    sites.push(summary.summary);
    if (summary.experiment) experiments.push(summary.experiment);
  }

  return { sites, skipped, experiments };
}

async function seedDemoSite(
  blueprint: DemoSiteBlueprint,
  userId: string,
  now: Date,
  withExperiment: boolean,
): Promise<{ summary: DemoSiteSummary; experiment: string | null }> {
  const website = await prisma.website.create({
    data: {
      userId,
      name: `${DEMO_NAME_PREFIX}${blueprint.name}`,
      domain: blueprint.domain,
      protocol: 'https',
      status: 'ACTIVE',
      description: blueprint.description,
      businessCategory: blueprint.businessCategory,
      targetAudience: blueprint.targetAudience,
      conversionGoal: blueprint.conversionGoal,
      brandName: blueprint.brandName,
      cmsType: blueprint.cmsType,
      primaryLanguage: 'en',
      targetLocales: ['en-US'],
      targetCountry: 'USA',
      isDemo: true,
    },
    select: { id: true },
  });

  await prisma.websiteSettings.create({
    data: {
      websiteId: website.id,
      autonomyLevel: blueprint.autonomyLevel,
      autoApproveSafe: false,
      thinContentWords: 300,
    },
  });

  await prisma.knowledgeBase.create({
    data: {
      websiteId: website.id,
      businessDescription: blueprint.description,
      audience: blueprint.targetAudience,
      toneOfVoice: blueprint.knowledge.toneOfVoice,
      brandStyle: blueprint.knowledge.brandStyle,
      preferredCta: blueprint.knowledge.preferredCta,
      prohibitedClaims: blueprint.knowledge.prohibitedClaims,
      writingGuidelines: blueprint.knowledge.writingGuidelines,
      uniqueValueProps: blueprint.knowledge.uniqueValueProps,
    },
  });

  await createManyChunked(prisma.brandFact, blueprint.facts.map((fact) => ({
    websiteId: website.id,
    fact: fact.fact,
    category: fact.category,
    source: 'internal',
    verified: true,
    verifiedAt: now,
  })));

  // The crawl is built with the real website id because issue fingerprints hash it — reusing the
  // same site later must reconcile onto the same fingerprints.
  const crawl = buildDemoCrawl(blueprint, website.id, now);
  const crawlResult = await persistDemoCrawl(blueprint, website.id, crawl, now);

  const metrics = buildDemoMetrics(blueprint, now);
  const search = await persistDemoSearchData(blueprint, website.id, crawl, metrics, crawlResult.pageIdByPath);

  // Open issues per page, so the page score can account for what is actually wrong with it.
  const openIssuesByPath = new Map<string, Array<{ severity: string; weight: number }>>();
  for (const issue of crawlResult.issues) {
    if (!issue.url) continue;
    const normalized = normalizeUrl(issue.url);
    const page = crawl.pages.find((candidate) => candidate.normalizedUrl === normalized);
    if (!page) continue;
    const list = openIssuesByPath.get(page.path) ?? [];
    list.push({ severity: issue.severity, weight: issue.weight });
    openIssuesByPath.set(page.path, list);
  }

  const insights = await persistDemoInsights(
    blueprint,
    website.id,
    crawl,
    search,
    crawlResult.pageIdByPath,
    openIssuesByPath,
    now,
  );

  const actions = await persistDemoActions(
    blueprint,
    website.id,
    userId,
    crawl,
    metrics,
    insights,
    crawlResult.issueLifetimes,
    { indexablePages: crawlResult.audit.stats.indexablePages, orphanPages: crawlResult.audit.stats.orphanPages },
    crawlResult.pageIdByPath,
    withExperiment,
    now,
  );

  await prisma.website.update({
    where: { id: website.id },
    data: {
      healthScore: crawlResult.health.score,
      geoScore: insights.geoScore,
      contentScore: insights.contentScore,
      aiVisibilityScore: insights.aiVisibilityScore,
      lastCrawlAt: new Date(now.getTime() - 86_400_000),
      lastAnalysisAt: new Date(now.getTime() - 86_400_000),
    },
  });

  // A report row so the reporting view has something real to render.
  await prisma.report.create({
    data: {
      websiteId: website.id,
      type: 'WEEKLY',
      title: `${blueprint.name} — weekly summary`,
      periodStart: metrics.range.start,
      periodEnd: metrics.range.end,
      data: json({
        clicks: metrics.siteDaily.reduce((total, day) => total + day.clicks, 0),
        impressions: metrics.siteDaily.reduce((total, day) => total + day.impressions, 0),
        healthScore: crawlResult.health.score,
        geoScore: insights.geoScore,
      }),
      summary: crawlResult.health.summary,
      highlights: json(
        insights.topOpportunities.slice(0, 3).map((opportunity) => ({
          title: opportunity.title,
          priority: opportunity.priority,
        })),
      ),
    },
  });

  const counts: Record<string, number> = {
    Website: 1,
    WebsiteSettings: 1,
    KnowledgeBase: 1,
    BrandFact: blueprint.facts.length,
    Report: 1,
    ...crawlResult.counts,
    ...search.counts,
    ...insights.counts,
    ...actions.counts,
  };

  log.info('demo site seeded', {
    domain: blueprint.domain,
    pages: crawl.pages.length,
    issues: crawlResult.issues.length,
    health: crawlResult.health.score,
  });

  return {
    experiment: actions.experimentOutcome,
    summary: {
      name: `${DEMO_NAME_PREFIX}${blueprint.name}`,
      domain: blueprint.domain,
      websiteId: website.id,
      healthScore: crawlResult.health.score,
      geoScore: insights.geoScore,
      counts,
    },
  };
}
