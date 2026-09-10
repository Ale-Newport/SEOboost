import {
  HEALTH_CATEGORY_WEIGHT,
  SEVERITY_WEIGHT,
  clamp,
  round,
  saturate,
  type ExplainableScore,
  type ScoreFactor,
} from '@seo/shared';
import type { IssueCategoryValue, IssueDraft, IssueSeverityValue } from '../types';

export interface HealthInput {
  issues: Array<{
    category: IssueCategoryValue | string;
    severity: IssueSeverityValue | string;
    weight: number;
    status?: string;
    /** Defaults to 'page' for rows written before scopes existed. */
    scope?: 'page' | 'site' | string | null;
  }>;
  /** Number of pages crawled — page-scoped penalties are normalised against site size. */
  pageCount: number;
}

/**
 * Site health score, 0-100.
 *
 * Method (shown verbatim in the UI methodology panel):
 *   1. Each open issue contributes `severityWeight × ruleWeight` penalty points to its category.
 *   2. Page-scoped penalties are normalised against site size, so one broken page on a 10-page
 *      site hurts more than one on a 10,000-page site — but a large site can still reach 0 in a
 *      category if enough pages are affected.
 *   3. Site-scoped penalties (a missing sitemap, no robots.txt, no Organization schema,
 *      duplicate-content clusters) are NOT diluted by page count. A missing sitemap is exactly as
 *      bad on a 10,000-page site as on a 10-page one, and normalising it away was simply wrong.
 *   4. The two normalised penalties are added and passed through one saturating curve.
 *   5. Category scores are combined using fixed, published weights.
 *
 * The result is deliberately NOT a black box: every category's contribution is returned.
 */
export function calculateHealthScore(input: HealthInput): ExplainableScore {
  const pageCount = Math.max(1, input.pageCount);
  const open = input.issues.filter((i) => !i.status || i.status === 'OPEN' || i.status === 'REGRESSED');

  const pagePenaltyByCategory = new Map<string, number>();
  const sitePenaltyByCategory = new Map<string, number>();
  const countByCategory = new Map<string, number>();
  for (const issue of open) {
    const severityWeight = SEVERITY_WEIGHT[issue.severity as keyof typeof SEVERITY_WEIGHT] ?? 1;
    const penalty = severityWeight * (issue.weight || 1);
    const target = issue.scope === 'site' ? sitePenaltyByCategory : pagePenaltyByCategory;
    target.set(issue.category, (target.get(issue.category) ?? 0) + penalty);
    countByCategory.set(issue.category, (countByCategory.get(issue.category) ?? 0) + 1);
  }

  const factors: ScoreFactor[] = [];
  let weightedScore = 0;
  let totalWeight = 0;

  for (const [category, weight] of Object.entries(HEALTH_CATEGORY_WEIGHT)) {
    if (weight === 0) continue;
    const pagePenalty = pagePenaltyByCategory.get(category) ?? 0;
    const sitePenalty = sitePenaltyByCategory.get(category) ?? 0;
    const count = countByCategory.get(category) ?? 0;

    // Page-scoped: the half-way point scales with site size, so ~1.5 severity-weighted issues per
    // 10 pages takes the category to 50. Floored at 4 so a tiny site is not scored on one page.
    const pageK = Math.max(4, pageCount * 0.15);
    // Site-scoped: a fixed half-way point. Eight weighted penalty points of site-wide problems
    // halves the category no matter how large the site is.
    const siteK = 8;

    const combinedRatio = pagePenalty / pageK + sitePenalty / siteK;
    const categoryScore = round((1 - saturate(combinedRatio, 1)) * 100, 1);

    weightedScore += categoryScore * weight;
    totalWeight += weight;

    factors.push({
      key: category,
      label: humanCategory(category),
      value: clamp(categoryScore / 100),
      weight,
      contribution: round(categoryScore * weight, 2),
      explanation:
        count === 0
          ? 'No open issues in this category.'
          : `${count} open issue${count === 1 ? '' : 's'}: ` +
            [
              pagePenalty > 0
                ? `${round(pagePenalty, 1)} page-level penalty point${pagePenalty === 1 ? '' : 's'} across ${pageCount} crawled pages`
                : null,
              sitePenalty > 0
                ? `${round(sitePenalty, 1)} site-wide penalty point${sitePenalty === 1 ? '' : 's'}, not scaled by site size`
                : null,
            ]
              .filter(Boolean)
              .join('; ') +
            '.',
    });
  }

  const score = totalWeight > 0 ? round(weightedScore / totalWeight, 1) : 100;
  const worst = [...factors].sort((a, b) => a.value - b.value)[0];

  return {
    score,
    factors: factors.sort((a, b) => b.weight - a.weight),
    summary:
      open.length === 0
        ? 'No open technical issues were found in the last crawl.'
        : `${open.length} open issue${open.length === 1 ? '' : 's'} across ${pageCount} crawled pages. Weakest area: ${
            worst ? `${worst.label} (${round(worst.value * 100, 0)}/100)` : 'n/a'
          }.`,
  };
}

function humanCategory(category: string): string {
  return category
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Convenience wrapper for the audit path, which has IssueDrafts rather than DB rows. */
export function healthFromDrafts(issues: IssueDraft[], pageCount: number): ExplainableScore {
  return calculateHealthScore({ issues, pageCount });
}

/** Band label used for colour-coding in the UI. */
export function healthBand(score: number): 'excellent' | 'good' | 'fair' | 'poor' {
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'good';
  if (score >= 55) return 'fair';
  return 'poor';
}
