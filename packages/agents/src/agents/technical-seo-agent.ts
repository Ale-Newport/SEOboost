import { prisma } from '@seo/db';
import { RULES, type RuleId } from '@seo/seo-engine';
import { SEVERITY_ORDER, SEVERITY_WEIGHT, clamp, mean, round, saturate } from '@seo/shared';
import { registerAgent } from '../runtime/registry';
import type { AgentContext, AgentDefinition, AgentResult } from '../types';
import {
  ActionCollector,
  NO_CRAWL,
  latestCrawl,
  loadSite,
  pluralise,
  propose,
  result,
  skipped,
  step,
  unique,
} from './shared';

const AGENT = 'TechnicalSEOAgent' as const;
const ALLOWED_ACTION_TYPES = ['FIX_TECHNICAL_ISSUE'] as const;

/** How many issues of one rule to name explicitly in the action evidence. */
const SAMPLE_URLS = 25;

// ── Pure grouping logic (unit-tested without a database) ──────────────────────

export type IssueSeverityName = (typeof SEVERITY_ORDER)[number];

/** The fields of a `TechnicalIssue` the clustering logic actually reads. */
export interface ClusterableIssue {
  id: string;
  ruleId: string;
  title: string;
  category: string;
  severity: IssueSeverityName;
  url: string | null;
  pageId: string | null;
  recommendation: string;
  autoFixable: boolean;
  estimatedImpact: number;
  confidence: number;
  weight: number;
}

export interface IssueCluster {
  ruleId: string;
  title: string;
  category: string;
  /** The worst severity present in the cluster — rules can be raised per finding. */
  severity: IssueSeverityName;
  count: number;
  autoFixableCount: number;
  /** True only when every issue in the cluster is machine-fixable. */
  fullyAutoFixable: boolean;
  /** Sample of affected URLs, capped so the evidence blob stays readable. */
  urls: string[];
  issueIds: string[];
  pageIds: string[];
  recommendation: string;
  /** Sum of severity weight × per-issue estimated impact. The ranking key before normalisation. */
  impactMass: number;
  /** 0-1, saturating: fixing 400 instances of a rule is not 400× better than fixing 40. */
  impact: number;
  /** 1-5 for the priority formula. */
  effort: number;
  /** 0-1, the mean confidence the audit had in these findings. */
  confidence: number;
  headline: string;
}

/**
 * Rule-specific phrasing so an action reads like a sentence a human would write
 * ("42 internal links point at redirects") instead of a rule id with a count bolted on.
 * Anything not listed falls back to the generic form, which is still correct.
 */
const HEADLINES: Partial<Record<RuleId, (n: number) => string>> = {
  HTTP_404: (n) => `${n} linked ${pluralise(n, 'URL')} ${pluralise(n, 'returns', 'return')} 404`,
  HTTP_5XX: (n) => `${n} ${pluralise(n, 'page')} ${pluralise(n, 'returns', 'return')} a server error`,
  FETCH_FAILED: (n) => `${n} ${pluralise(n, 'page')} could not be fetched`,
  REDIRECT_CHAIN: (n) => `${n} redirect ${pluralise(n, 'chain')} to flatten`,
  REDIRECT_LOOP: (n) => `${n} redirect ${pluralise(n, 'loop')} to break`,
  INTERNAL_LINK_TO_REDIRECT: (n) => `${n} internal ${pluralise(n, 'link')} ${pluralise(n, 'points', 'point')} at redirects`,
  INTERNAL_LINK_TO_NOINDEX: (n) => `${n} internal ${pluralise(n, 'link')} ${pluralise(n, 'points', 'point')} at non-indexable pages`,
  BROKEN_INTERNAL_LINK: (n) => `${n} broken internal ${pluralise(n, 'link')}`,
  BROKEN_EXTERNAL_LINK: (n) => `${n} broken external ${pluralise(n, 'link')}`,
  MISSING_TITLE: (n) => `${n} ${pluralise(n, 'page')} ${pluralise(n, 'has', 'have')} no title tag`,
  DUPLICATE_TITLE: (n) => `${n} ${pluralise(n, 'page')} ${pluralise(n, 'shares', 'share')} a duplicate title`,
  TITLE_TOO_LONG: (n) => `${n} ${pluralise(n, 'title')} ${pluralise(n, 'is', 'are')} truncated in search results`,
  TITLE_TOO_SHORT: (n) => `${n} ${pluralise(n, 'title')} ${pluralise(n, 'is', 'are')} too short to describe the page`,
  MISSING_META_DESCRIPTION: (n) => `${n} ${pluralise(n, 'page')} ${pluralise(n, 'has', 'have')} no meta description`,
  DUPLICATE_META_DESCRIPTION: (n) => `${n} ${pluralise(n, 'page')} ${pluralise(n, 'shares', 'share')} a duplicate meta description`,
  MISSING_H1: (n) => `${n} ${pluralise(n, 'page')} ${pluralise(n, 'has', 'have')} no H1`,
  MULTIPLE_H1: (n) => `${n} ${pluralise(n, 'page')} ${pluralise(n, 'has', 'have')} more than one H1`,
  MISSING_CANONICAL: (n) => `${n} ${pluralise(n, 'page')} ${pluralise(n, 'has', 'have')} no canonical tag`,
  CANONICAL_TO_REDIRECT: (n) => `${n} ${pluralise(n, 'canonical')} ${pluralise(n, 'points', 'point')} at a redirect`,
  CANONICAL_TO_404: (n) => `${n} ${pluralise(n, 'canonical')} ${pluralise(n, 'points', 'point')} at a 404`,
  NOINDEX_WITH_TRAFFIC: (n) => `${n} noindexed ${pluralise(n, 'page')} still ${pluralise(n, 'earns', 'earn')} traffic`,
  NOINDEX_IN_SITEMAP: (n) => `${n} noindexed ${pluralise(n, 'URL')} ${pluralise(n, 'is', 'are')} listed in the sitemap`,
  ORPHAN_PAGE: (n) => `${n} orphan ${pluralise(n, 'page')} with no internal links in`,
  LOW_INTERNAL_LINKS: (n) => `${n} ${pluralise(n, 'page')} ${pluralise(n, 'has', 'have')} almost no internal links in`,
  DEEP_PAGE: (n) => `${n} ${pluralise(n, 'page')} sit too deep in the site structure`,
  THIN_CONTENT: (n) => `${n} thin ${pluralise(n, 'page')} below the content threshold`,
  DUPLICATE_CONTENT: (n) => `${n} ${pluralise(n, 'page')} ${pluralise(n, 'duplicates', 'duplicate')} other pages`,
  NEAR_DUPLICATE_CONTENT: (n) => `${n} ${pluralise(n, 'page')} ${pluralise(n, 'is', 'are')} near-duplicate${n === 1 ? '' : 's'} of other pages`,
  MISSING_IMAGE_ALT: (n) => `${n} ${pluralise(n, 'page')} ${pluralise(n, 'has', 'have')} images without alt text`,
  MISSING_STRUCTURED_DATA: (n) => `${n} ${pluralise(n, 'page')} ${pluralise(n, 'has', 'have')} no structured data`,
  MALFORMED_STRUCTURED_DATA: (n) => `${n} structured-data ${pluralise(n, 'block')} ${pluralise(n, 'is', 'are')} malformed`,
  MIXED_CONTENT: (n) => `${n} HTTPS ${pluralise(n, 'page')} ${pluralise(n, 'loads', 'load')} insecure resources`,
  SLOW_RESPONSE: (n) => `${n} ${pluralise(n, 'page')} ${pluralise(n, 'responds', 'respond')} slowly`,
};

function severityRank(severity: IssueSeverityName): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/**
 * Effort on the 1-5 scale used by `calculatePriority`.
 *
 * A machine-applicable fix stays cheap however many instances there are — that is the entire
 * point of it being machine-applicable. A manual fix scales with the number of URLs a person has
 * to touch.
 */
export function clusterEffort(count: number, fullyAutoFixable: boolean): number {
  if (fullyAutoFixable) return count > 200 ? 2 : 1;
  if (count <= 3) return 2;
  if (count <= 20) return 3;
  if (count <= 100) return 4;
  return 5;
}

/**
 * Group open issues by rule, then rank the clusters by how much of the site's technical debt
 * each one represents.
 *
 * Grouping by *rule* rather than by page is what turns 400 rows into eight decisions: one fix
 * applied 400 times is one action, and its evidence is the list of URLs.
 */
export function groupTechnicalIssues(issues: readonly ClusterableIssue[]): IssueCluster[] {
  const byRule = new Map<string, ClusterableIssue[]>();
  for (const issue of issues) {
    const list = byRule.get(issue.ruleId);
    if (list) list.push(issue);
    else byRule.set(issue.ruleId, [issue]);
  }

  const clusters: IssueCluster[] = [];
  for (const [ruleId, group] of byRule) {
    const count = group.length;
    const worst = group.reduce(
      (acc, issue) => (severityRank(issue.severity) < severityRank(acc) ? issue.severity : acc),
      group[0]!.severity,
    );
    const autoFixableCount = group.filter((issue) => issue.autoFixable).length;
    const impactMass = group.reduce(
      (total, issue) => total + (SEVERITY_WEIGHT[issue.severity] / 10) * Math.max(issue.estimatedImpact, 0.05) * issue.weight,
      0,
    );

    // k = 6 puts the half-way point at roughly "six critical pages' worth" of debt, so a single
    // CRITICAL finding still scores meaningfully while a long tail of LOW findings does not
    // outrank it purely on volume.
    const impact = clamp(saturate(impactMass, 6));
    const fullyAutoFixable = autoFixableCount === count && count > 0;

    clusters.push({
      ruleId,
      title: group[0]!.title,
      category: group[0]!.category,
      severity: worst,
      count,
      autoFixableCount,
      fullyAutoFixable,
      urls: unique(group.map((issue) => issue.url).filter((url): url is string => Boolean(url))).slice(0, SAMPLE_URLS),
      issueIds: group.map((issue) => issue.id),
      pageIds: unique(group.map((issue) => issue.pageId).filter((id): id is string => Boolean(id))),
      recommendation: group[0]!.recommendation,
      impactMass: round(impactMass, 3),
      impact: round(impact, 3),
      effort: clusterEffort(count, fullyAutoFixable),
      confidence: round(mean(group.map((issue) => issue.confidence)), 3),
      headline: headlineFor(ruleId, count, group[0]!.title),
    });
  }

  return clusters.sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || b.impactMass - a.impactMass,
  );
}

function headlineFor(ruleId: string, count: number, title: string): string {
  const phrase = HEADLINES[ruleId as RuleId];
  if (phrase) return capitalise(phrase(count));
  return count === 1 ? title : `${count} pages: ${title.toLowerCase()}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ── Agent ─────────────────────────────────────────────────────────────────────

async function run(ctx: AgentContext): Promise<AgentResult> {
  const site = await loadSite(ctx.websiteId);
  const crawl = await step(ctx, 'get_latest_crawl', { websiteId: ctx.websiteId }, () => latestCrawl(ctx.websiteId));
  if (!crawl) return skipped('No crawl to audit.', NO_CRAWL);

  const maxActions = typeof ctx.input.maxActions === 'number' ? Math.max(1, ctx.input.maxActions) : 8;

  const issues = await step(
    ctx,
    'list_open_technical_issues',
    { websiteId: ctx.websiteId },
    () =>
      prisma.technicalIssue.findMany({
        where: { websiteId: ctx.websiteId, status: { in: ['OPEN', 'REGRESSED'] } },
        select: {
          id: true,
          ruleId: true,
          title: true,
          category: true,
          severity: true,
          url: true,
          pageId: true,
          recommendation: true,
          autoFixable: true,
          estimatedImpact: true,
          confidence: true,
          weight: true,
        },
        take: 20_000,
      }),
    (rows) => ({ open: rows.length }),
  );

  if (issues.length === 0) {
    return result({
      summary: `No open technical issues on ${site.domain}. The last crawl covered ${crawl.pagesCrawled} pages.`,
      confidence: 0.9,
      data: { crawlId: crawl.id, openIssues: 0 },
    });
  }

  const clusters = groupTechnicalIssues(
    issues.map((issue) => ({
      id: issue.id,
      ruleId: issue.ruleId,
      title: issue.title,
      category: issue.category,
      severity: issue.severity,
      url: issue.url,
      pageId: issue.pageId,
      recommendation: issue.recommendation,
      autoFixable: issue.autoFixable,
      estimatedImpact: issue.estimatedImpact,
      confidence: issue.confidence,
      weight: issue.weight,
    })),
  );

  const actions = new ActionCollector();
  for (const cluster of clusters.slice(0, maxActions)) {
    const rule = RULES[cluster.ruleId as RuleId];
    await propose(ctx, actions, {
      type: 'FIX_TECHNICAL_ISSUE',
      title: cluster.headline,
      reasoning:
        `${cluster.headline}. ${rule?.rationale ?? ''} ${cluster.recommendation}`.trim() +
        (cluster.fullyAutoFixable
          ? ' Every instance of this rule is machine-applicable, so the platform can apply the fix and roll it back.'
          : ` ${cluster.autoFixableCount} of ${cluster.count} ${pluralise(cluster.count, 'instance')} can be applied automatically; the rest need a person.`),
      evidence: {
        ruleId: cluster.ruleId,
        severity: cluster.severity,
        category: cluster.category,
        affected: cluster.count,
        autoFixable: cluster.autoFixableCount,
        sampleUrls: cluster.urls,
        impactMass: cluster.impactMass,
        crawlId: crawl.id,
        method: 'Grouped from the open TechnicalIssue rows produced by the deterministic rule engine.',
      },
      affectedUrls: cluster.urls,
      payload: {
        mode: cluster.fullyAutoFixable ? 'auto' : 'advisory',
        ruleId: cluster.ruleId,
        issueIds: cluster.issueIds.slice(0, 500),
        pageIds: cluster.pageIds.slice(0, 500),
      },
      impact: cluster.impact,
      confidence: cluster.confidence,
      effort: cluster.effort,
      sourceType: 'TechnicalIssueCluster',
      sourceId: `${cluster.ruleId}:${crawl.id}`,
      ...(cluster.fullyAutoFixable
        ? {}
        : {
            advisory: `Only ${cluster.autoFixableCount} of ${cluster.count} instances can be applied by the platform; the rest need a person.`,
          }),
    });
  }

  const bySeverity = SEVERITY_ORDER.map((severity) => ({
    severity,
    issues: issues.filter((issue) => issue.severity === severity).length,
  })).filter((entry) => entry.issues > 0);

  return result({
    summary:
      `${issues.length} open technical ${pluralise(issues.length, 'issue')} across ${clusters.length} ${pluralise(clusters.length, 'rule')}. ` +
      `Proposed ${actions.actionsCreated.length} ${pluralise(actions.actionsCreated.length, 'fix', 'fixes')} covering the highest-impact clusters.`,
    // Deterministic: the findings are measurements, not judgements, so confidence is high but
    // not absolute — the audit itself carries per-rule confidence.
    confidence: round(clamp(mean(clusters.map((c) => c.confidence))), 2),
    actionsCreated: actions.actionsCreated,
    approvalsCreated: actions.approvalsCreated,
    findings: clusters.slice(0, 25).map((cluster) => ({
      kind: 'issue-cluster',
      ruleId: cluster.ruleId,
      headline: cluster.headline,
      severity: cluster.severity,
      category: cluster.category,
      count: cluster.count,
      fullyAutoFixable: cluster.fullyAutoFixable,
      sampleUrls: cluster.urls.slice(0, 5),
      recommendation: cluster.recommendation,
    })),
    data: {
      crawlId: crawl.id,
      openIssues: issues.length,
      clusters: clusters.length,
      bySeverity,
    },
  });
}

export const technicalSeoAgent: AgentDefinition = {
  name: AGENT,
  label: 'Technical SEO',
  description:
    'Groups open technical issues by rule and proposes fixes for the clusters that carry the most technical debt.',
  allowedActionTypes: [...ALLOWED_ACTION_TYPES],
  tools: ['get_latest_crawl', 'list_open_technical_issues'],
  requiresAi: false,
  run,
};

registerAgent(technicalSeoAgent);
