import { clamp, jaccardSimilarity, normalizeKeyword, percentChange, round } from '@seo/shared';

export interface PortfolioSiteInput {
  websiteId: string;
  name: string;
  domain: string;
  healthScore: number | null;
  geoScore: number | null;
  aiVisibilityScore: number | null;
  clicks28d: number;
  clicksPrev28d: number;
  impressions28d: number;
  impressionsPrev28d: number;
  avgPosition: number | null;
  openCriticalIssues: number;
  openIssues: number;
  opportunityCount: number;
  topOpportunityScore: number;
  pendingApprovals: number;
  topKeywords: string[];
  topicNames: string[];
  lastCrawlAt: Date | null;
  lastAnalysisAt: Date | null;
}

export interface PortfolioInsight {
  type:
    | 'STRONGEST_GROWTH'
    | 'NEEDS_ATTENTION'
    | 'HIGHEST_OPPORTUNITY'
    | 'THEME_OVERLAP'
    | 'INTERNAL_COMPETITION'
    | 'STALE_DATA'
    | 'CROSS_LINK_CANDIDATE';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  websiteIds: string[];
  metric?: number;
}

/**
 * Portfolio-level intelligence across every site the operator owns.
 *
 * Deliberately conservative on cross-site linking: it only *flags* legitimate topical
 * relationships for a human to judge. It never proposes building links between owned sites purely
 * for SEO — that is a link scheme, and it is out of scope for this product.
 */
export function analysePortfolio(sites: PortfolioSiteInput[]): {
  insights: PortfolioInsight[];
  totals: {
    websites: number;
    clicks28d: number;
    clicksPrev28d: number;
    growthPct: number | null;
    impressions28d: number;
    openIssues: number;
    criticalIssues: number;
    pendingApprovals: number;
    avgHealth: number | null;
    avgGeo: number | null;
  };
} {
  const insights: PortfolioInsight[] = [];

  const totals = {
    websites: sites.length,
    clicks28d: sites.reduce((s, x) => s + x.clicks28d, 0),
    clicksPrev28d: sites.reduce((s, x) => s + x.clicksPrev28d, 0),
    growthPct: null as number | null,
    impressions28d: sites.reduce((s, x) => s + x.impressions28d, 0),
    openIssues: sites.reduce((s, x) => s + x.openIssues, 0),
    criticalIssues: sites.reduce((s, x) => s + x.openCriticalIssues, 0),
    pendingApprovals: sites.reduce((s, x) => s + x.pendingApprovals, 0),
    avgHealth: averageOf(sites.map((s) => s.healthScore)),
    avgGeo: averageOf(sites.map((s) => s.geoScore)),
  };
  totals.growthPct = percentChange(totals.clicksPrev28d, totals.clicks28d);

  // Growth leaders and laggards
  const withGrowth = sites
    .map((site) => ({ site, growth: percentChange(site.clicksPrev28d, site.clicks28d) }))
    .filter((x) => x.growth !== null && x.site.clicksPrev28d >= 20) as Array<{ site: PortfolioSiteInput; growth: number }>;

  const best = [...withGrowth].sort((a, b) => b.growth - a.growth)[0];
  if (best && best.growth > 5) {
    insights.push({
      type: 'STRONGEST_GROWTH',
      severity: 'info',
      title: `${best.site.name} is your strongest growth this period`,
      detail:
        `Organic clicks are up ${best.growth.toFixed(1)}% (${best.site.clicksPrev28d.toLocaleString()} → ` +
        `${best.site.clicks28d.toLocaleString()}). Whatever is working here is worth replicating on the other sites — ` +
        'check its recent action history for what changed.',
      websiteIds: [best.site.websiteId],
      metric: best.growth,
    });
  }

  const worst = [...withGrowth].sort((a, b) => a.growth - b.growth)[0];
  if (worst && worst.growth < -15) {
    insights.push({
      type: 'NEEDS_ATTENTION',
      severity: worst.growth < -30 ? 'critical' : 'warning',
      title: `${worst.site.name} is losing organic traffic`,
      detail:
        `Clicks are down ${Math.abs(worst.growth).toFixed(1)}% (${worst.site.clicksPrev28d.toLocaleString()} → ` +
        `${worst.site.clicks28d.toLocaleString()}). Investigate declining pages and recent ranking losses before ` +
        'spending effort on new content here.',
      websiteIds: [worst.site.websiteId],
      metric: worst.growth,
    });
  }

  for (const site of sites) {
    if (site.openCriticalIssues > 0) {
      insights.push({
        type: 'NEEDS_ATTENTION',
        severity: 'critical',
        title: `${site.name} has ${site.openCriticalIssues} critical technical issue${site.openCriticalIssues === 1 ? '' : 's'}`,
        detail: 'Critical issues block indexing or serve errors to crawlers. Clear these before any content work.',
        websiteIds: [site.websiteId],
        metric: site.openCriticalIssues,
      });
    }
  }

  const highestOpportunity = [...sites]
    .filter((s) => s.opportunityCount > 0)
    .sort((a, b) => b.topOpportunityScore - a.topOpportunityScore)[0];
  if (highestOpportunity) {
    insights.push({
      type: 'HIGHEST_OPPORTUNITY',
      severity: 'info',
      title: `${highestOpportunity.name} holds the highest-scoring opportunity in the portfolio`,
      detail:
        `${highestOpportunity.opportunityCount} open opportunit${highestOpportunity.opportunityCount === 1 ? 'y' : 'ies'}, ` +
        `top priority scoring ${highestOpportunity.topOpportunityScore.toFixed(0)}/100. If your time this week is limited, ` +
        'this is where it converts best.',
      websiteIds: [highestOpportunity.websiteId],
      metric: highestOpportunity.topOpportunityScore,
    });
  }

  // Topical overlap between sites
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      const a = sites[i]!;
      const b = sites[j]!;
      const topicOverlap = jaccardSimilarity(a.topicNames.join(' '), b.topicNames.join(' '));
      const sharedKeywords = intersect(a.topKeywords, b.topKeywords);

      if (sharedKeywords.length >= 5) {
        insights.push({
          type: 'INTERNAL_COMPETITION',
          severity: 'warning',
          title: `${a.name} and ${b.name} compete for ${sharedKeywords.length} of the same queries`,
          detail:
            `Shared queries include: ${sharedKeywords.slice(0, 5).join(', ')}. Two of your own sites bidding for the same ` +
            'results splits your visibility. Decide which site owns each query and differentiate the other.',
          websiteIds: [a.websiteId, b.websiteId],
          metric: sharedKeywords.length,
        });
      } else if (topicOverlap >= 0.25) {
        insights.push({
          type: 'THEME_OVERLAP',
          severity: 'info',
          title: `${a.name} and ${b.name} cover ${Math.round(topicOverlap * 100)}% overlapping themes`,
          detail:
            'Shared subject matter means research, briefs and first-party data can be reused across both sites. ' +
            'It also means you should check they are not converging on the same queries.',
          websiteIds: [a.websiteId, b.websiteId],
          metric: round(topicOverlap, 3),
        });
      }
    }
  }

  // Stale data
  const now = Date.now();
  const stale = sites.filter(
    (s) => !s.lastCrawlAt || now - s.lastCrawlAt.getTime() > 21 * 86_400_000,
  );
  if (stale.length > 0) {
    insights.push({
      type: 'STALE_DATA',
      severity: 'warning',
      title: `${stale.length} site${stale.length === 1 ? '' : 's'} ${stale.length === 1 ? 'has' : 'have'} not been crawled recently`,
      detail:
        `${stale.map((s) => s.name).join(', ')}. Recommendations are only as current as the last crawl — schedule or run one.`,
      websiteIds: stale.map((s) => s.websiteId),
      metric: stale.length,
    });
  }

  const severityRank = { critical: 0, warning: 1, info: 2 } as const;
  return {
    insights: insights.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]),
    totals,
  };
}

function averageOf(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return present.length ? round(present.reduce((s, v) => s + v, 0) / present.length, 1) : null;
}

function intersect(a: string[], b: string[]): string[] {
  const setB = new Set(b.map(normalizeKeyword));
  return a.filter((keyword) => setB.has(normalizeKeyword(keyword)));
}

/** Which site deserves the next hour of work, and why. */
export function rankSitesByNeed(sites: PortfolioSiteInput[]): Array<{
  websiteId: string;
  name: string;
  needScore: number;
  reason: string;
}> {
  return sites
    .map((site) => {
      const growth = percentChange(site.clicksPrev28d, site.clicks28d);
      const declineSignal = growth !== null && growth < 0 ? clamp(-growth / 50) : 0;
      const criticalSignal = clamp(site.openCriticalIssues / 3);
      const healthSignal = site.healthScore !== null ? clamp(1 - site.healthScore / 100) : 0.3;
      const opportunitySignal = clamp(site.topOpportunityScore / 100);
      const approvalSignal = clamp(site.pendingApprovals / 5);

      const needScore = round(
        (criticalSignal * 0.3 + declineSignal * 0.25 + opportunitySignal * 0.2 + healthSignal * 0.15 + approvalSignal * 0.1) * 100,
        1,
      );

      const reasons: string[] = [];
      if (site.openCriticalIssues > 0) reasons.push(`${site.openCriticalIssues} critical issue(s)`);
      if (growth !== null && growth < -10) reasons.push(`traffic down ${Math.abs(growth).toFixed(0)}%`);
      if (site.pendingApprovals > 0) reasons.push(`${site.pendingApprovals} action(s) waiting on you`);
      if (site.topOpportunityScore >= 70) reasons.push(`a ${site.topOpportunityScore.toFixed(0)}/100 opportunity open`);
      if (site.healthScore !== null && site.healthScore < 70) reasons.push(`health ${site.healthScore.toFixed(0)}/100`);

      return {
        websiteId: site.websiteId,
        name: site.name,
        needScore,
        reason: reasons.length ? reasons.join(', ') : 'Stable — no urgent signals.',
      };
    })
    .sort((a, b) => b.needScore - a.needScore);
}
