import { describe, expect, it } from 'vitest';
import { calculateHealthScore, healthBand } from '../scoring/health';
import { calculatePageSeoScore } from '../scoring/page-score';
import { calculateKeywordOpportunity, calculatePageOpportunity, detectCtrOpportunity } from '../scoring/keyword-opportunity';
import { calculatePriority, canAutoExecute, riskBandForActionType } from '../scoring/priority';

describe('calculateHealthScore', () => {
  it('scores a clean site at 100 and explains every category', () => {
    const result = calculateHealthScore({ issues: [], pageCount: 50 });
    expect(result.score).toBe(100);
    expect(result.factors.length).toBeGreaterThan(5);
    expect(result.factors.every((f) => f.explanation.length > 0)).toBe(true);
    expect(result.summary).toContain('No open technical issues');
  });

  it('penalises critical issues far more than info issues', () => {
    const critical = calculateHealthScore({
      issues: [{ category: 'INDEXABILITY', severity: 'CRITICAL', weight: 5 }], pageCount: 20,
    });
    const info = calculateHealthScore({
      issues: [{ category: 'INDEXABILITY', severity: 'INFO', weight: 0.5 }], pageCount: 20,
    });
    expect(critical.score).toBeLessThan(info.score - 5);
  });

  it('normalises against site size', () => {
    const issues = Array.from({ length: 10 }, () => ({ category: 'METADATA' as const, severity: 'MEDIUM' as const, weight: 2 }));
    const smallSite = calculateHealthScore({ issues, pageCount: 10 });
    const largeSite = calculateHealthScore({ issues, pageCount: 5000 });
    expect(largeSite.score).toBeGreaterThan(smallSite.score);
  });

  it('ignores resolved issues', () => {
    const withResolved = calculateHealthScore({
      issues: [{ category: 'CONTENT', severity: 'CRITICAL', weight: 5, status: 'RESOLVED' }], pageCount: 20,
    });
    expect(withResolved.score).toBe(100);
  });

  it('bands scores consistently', () => {
    expect(healthBand(95)).toBe('excellent');
    expect(healthBand(80)).toBe('good');
    expect(healthBand(60)).toBe('fair');
    expect(healthBand(30)).toBe('poor');
  });
});

describe('calculatePageSeoScore', () => {
  const goodPage = {
    title: 'AI Workout Planner — Build a Personalised Gym Routine',
    metaDescription: 'Create a personalised gym routine in minutes with an AI workout planner that adapts to your equipment and schedule.',
    h1: 'AI Workout Planner',
    headingCount: 8,
    wordCount: 1600,
    isIndexable: true,
    internalLinksIn: 12,
    internalLinksOut: 9,
    schemaTypes: ['Article', 'BreadcrumbList'],
    imageCount: 4,
    imagesMissingAlt: 0,
    openIssues: [],
    targetKeyword: 'ai workout planner',
    textContent: 'A readable sentence about workouts. '.repeat(80),
  };

  it('scores a well-optimised page highly', () => {
    const result = calculatePageSeoScore(goodPage);
    expect(result.score).toBeGreaterThan(80);
    expect(result.factors).toHaveLength(9);
  });

  it('zeroes indexability for a noindex page and drops the score sharply', () => {
    const result = calculatePageSeoScore({ ...goodPage, isIndexable: false, indexabilityReason: 'noindex meta tag' });
    expect(result.factors.find((f) => f.key === 'indexability')!.value).toBe(0);
    expect(result.score).toBeLessThan(calculatePageSeoScore(goodPage).score - 10);
  });

  it('rewards a title containing the target keyword', () => {
    const withKeyword = calculatePageSeoScore(goodPage);
    const withoutKeyword = calculatePageSeoScore({ ...goodPage, title: 'Some Unrelated Heading About Nothing Here' });
    expect(withKeyword.score).toBeGreaterThan(withoutKeyword.score);
  });

  it('every factor contributes a documented explanation', () => {
    for (const factor of calculatePageSeoScore(goodPage).factors) {
      expect(factor.explanation.trim().length).toBeGreaterThan(3);
      expect(factor.weight).toBeGreaterThan(0);
    }
  });
});

describe('calculateKeywordOpportunity', () => {
  const base = {
    keyword: 'ai workout planner',
    currentPosition: 14,
    impressions28d: 12_400,
    clicks28d: 90,
    ctr28d: 0.007,
    searchVolume: 4800,
    difficulty: 32,
    relevance: 0.9,
    businessValue: 0.8,
    isContentGap: false,
    competitorsRanking: 2,
    topicalAuthority: 0.7,
    geoPotential: 0.75,
    maxImpressionsOnSite: 20_000,
  };

  it('rates striking-distance keywords highest', () => {
    const striking = calculateKeywordOpportunity(base);
    const alreadyTop3 = calculateKeywordOpportunity({ ...base, currentPosition: 2 });
    const veryFar = calculateKeywordOpportunity({ ...base, currentPosition: 80 });
    expect(striking.score).toBeGreaterThan(alreadyTop3.score);
    expect(striking.score).toBeGreaterThan(veryFar.score);
  });

  it('produces a human-readable explanation naming the evidence', () => {
    const result = calculateKeywordOpportunity(base);
    expect(result.summary.length).toBeGreaterThan(20);
    expect(result.factors.find((f) => f.key === 'rankingPotential')!.explanation).toContain('striking distance');
  });

  it('degrades gracefully with no SERP provider data', () => {
    const result = calculateKeywordOpportunity({ ...base, difficulty: null, competitorsRanking: null });
    const competition = result.factors.find((f) => f.key === 'competitionGap')!;
    expect(competition.value).toBe(0.5);
    expect(competition.explanation).toContain('SERP provider');
  });

  it('weights sum to 1 so the score cannot exceed 100', () => {
    const perfect = calculateKeywordOpportunity({
      ...base, currentPosition: 14, relevance: 1, businessValue: 1, isContentGap: true,
      difficulty: 0, topicalAuthority: 1, geoPotential: 1, impressions28d: 20_000,
    });
    expect(perfect.score).toBeLessThanOrEqual(100);
    expect(perfect.score).toBeGreaterThan(85);
  });
});

describe('detectCtrOpportunity', () => {
  it('detects an under-clicked page ranking in the top 10', () => {
    const result = detectCtrOpportunity({ position: 4, impressions: 5000, clicks: 60, ctr: 0.012, minImpressions: 100 });
    expect(result).not.toBeNull();
    expect(result!.potentialClicks).toBeGreaterThan(100);
    expect(result!.severity).toBe('high');
  });

  it('ignores pages already performing at or above the curve', () => {
    expect(detectCtrOpportunity({ position: 4, impressions: 5000, clicks: 400, ctr: 0.08, minImpressions: 100 })).toBeNull();
  });

  it('ignores low-impression noise and deep rankings', () => {
    expect(detectCtrOpportunity({ position: 4, impressions: 10, clicks: 0, ctr: 0, minImpressions: 100 })).toBeNull();
    expect(detectCtrOpportunity({ position: 45, impressions: 5000, clicks: 1, ctr: 0.0002, minImpressions: 100 })).toBeNull();
  });
});

describe('calculatePriority', () => {
  it('ranks high-impact low-effort work above low-impact high-effort work', () => {
    const easy = calculatePriority({ impact: 0.9, confidence: 0.9, businessValue: 0.9, effort: 1, risk: 1 });
    const hard = calculatePriority({ impact: 0.3, confidence: 0.4, businessValue: 0.3, effort: 5, risk: 4 });
    expect(easy.score).toBeGreaterThan(hard.score);
    expect(easy.score).toBeLessThanOrEqual(100);
  });

  it('explains the formula in the summary', () => {
    const result = calculatePriority({ impact: 0.8, confidence: 0.7, businessValue: 0.6, effort: 2, risk: 1 });
    expect(result.summary).toContain('effort 2');
    expect(result.summary).toContain('risk 1');
  });

  it('damps actions with a poor track record on this site', () => {
    const neutral = calculatePriority({ impact: 0.8, confidence: 0.8, businessValue: 0.8, effort: 2, risk: 1 });
    const bad = calculatePriority({
      impact: 0.8, confidence: 0.8, businessValue: 0.8, effort: 2, risk: 1,
      historicalSuccessRate: 0.1, historicalSampleSize: 20,
    });
    const good = calculatePriority({
      impact: 0.8, confidence: 0.8, businessValue: 0.8, effort: 2, risk: 1,
      historicalSuccessRate: 0.9, historicalSampleSize: 20,
    });
    expect(bad.score).toBeLessThan(neutral.score);
    expect(good.score).toBeGreaterThan(neutral.score);
  });

  it('shrinks the history adjustment toward neutral for tiny samples', () => {
    const tinySample = calculatePriority({
      impact: 0.8, confidence: 0.8, businessValue: 0.8, effort: 2, risk: 1,
      historicalSuccessRate: 0, historicalSampleSize: 1,
    });
    const bigSample = calculatePriority({
      impact: 0.8, confidence: 0.8, businessValue: 0.8, effort: 2, risk: 1,
      historicalSuccessRate: 0, historicalSampleSize: 50,
    });
    expect(tinySample.score).toBeGreaterThan(bigSample.score);
  });
});

describe('canAutoExecute — the autonomy guardrail', () => {
  it('never auto-executes redirects or consolidations at any level', () => {
    for (const level of ['L0_INSIGHTS_ONLY', 'L1_DRAFTS_ONLY', 'L2_SAFE_TECHNICAL', 'L3_MOST_REVERSIBLE', 'L4_HIGH_AUTONOMY']) {
      for (const actionType of ['CREATE_REDIRECT', 'CONSOLIDATE_PAGES', 'CUSTOM']) {
        const result = canAutoExecute({ actionType, autonomyLevel: level, autoApproveSafe: true });
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('approval');
      }
    }
  });

  it('blocks everything at levels 0 and 1', () => {
    for (const actionType of ['ADD_INTERNAL_LINKS', 'UPDATE_TITLE', 'PUBLISH_CONTENT', 'ADD_STRUCTURED_DATA']) {
      expect(canAutoExecute({ actionType, autonomyLevel: 'L1_DRAFTS_ONLY', autoApproveSafe: false }).allowed).toBe(false);
    }
  });

  it('allows only safe technical work at level 2', () => {
    expect(canAutoExecute({ actionType: 'ADD_STRUCTURED_DATA', autonomyLevel: 'L2_SAFE_TECHNICAL', autoApproveSafe: false }).allowed).toBe(true);
    expect(canAutoExecute({ actionType: 'PUBLISH_CONTENT', autonomyLevel: 'L2_SAFE_TECHNICAL', autoApproveSafe: false }).allowed).toBe(false);
  });

  it('allows publishing only at level 4', () => {
    expect(canAutoExecute({ actionType: 'PUBLISH_CONTENT', autonomyLevel: 'L3_MOST_REVERSIBLE', autoApproveSafe: false }).allowed).toBe(false);
    expect(canAutoExecute({ actionType: 'PUBLISH_CONTENT', autonomyLevel: 'L4_HIGH_AUTONOMY', autoApproveSafe: false }).allowed).toBe(true);
  });

  it('classifies action risk consistently', () => {
    expect(riskBandForActionType('CREATE_REDIRECT')).toBe('HIGH');
    expect(riskBandForActionType('ADD_INTERNAL_LINKS')).toBe('SAFE');
    expect(riskBandForActionType('UPDATE_CONTENT')).toBe('MEDIUM');
    expect(riskBandForActionType('UNKNOWN_FUTURE_ACTION')).toBe('HIGH');
  });
});

describe('calculatePageOpportunity', () => {
  it('prioritises a striking-distance page with a CTR gap', () => {
    const strong = calculatePageOpportunity({
      impressions28d: 9000, clicks28d: 40, position28d: 12, ctr28d: 0.004,
      clicksTrendPct: -30, seoScore: 55, internalLinksIn: 3, wordCount: 700,
      openIssueCount: 2, maxImpressionsOnSite: 12_000,
    });
    const weak = calculatePageOpportunity({
      impressions28d: 20, clicks28d: 1, position28d: 70, ctr28d: 0.05,
      clicksTrendPct: 2, seoScore: 92, internalLinksIn: 20, wordCount: 2000,
      openIssueCount: 0, maxImpressionsOnSite: 12_000,
    });
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.summary.length).toBeGreaterThan(10);
  });
});

describe('calculateHealthScore — issue scope', () => {
  const siteWide = [
    { category: 'CRAWLABILITY' as const, severity: 'MEDIUM' as const, weight: 2, scope: 'site' as const },
    { category: 'CRAWLABILITY' as const, severity: 'LOW' as const, weight: 1, scope: 'site' as const },
  ];

  it('does not dilute a site-wide issue by page count', () => {
    const smallSite = calculateHealthScore({ issues: siteWide, pageCount: 5 });
    const hugeSite = calculateHealthScore({ issues: siteWide, pageCount: 50_000 });
    // A missing sitemap is exactly as bad on a huge site as on a tiny one.
    expect(hugeSite.score).toBeCloseTo(smallSite.score, 1);
  });

  it('still dilutes page-level issues by page count', () => {
    const pageIssues = Array.from({ length: 10 }, () => ({
      category: 'METADATA' as const, severity: 'MEDIUM' as const, weight: 2, scope: 'page' as const,
    }));
    const smallSite = calculateHealthScore({ issues: pageIssues, pageCount: 12 });
    const hugeSite = calculateHealthScore({ issues: pageIssues, pageCount: 50_000 });
    expect(hugeSite.score).toBeGreaterThan(smallSite.score + 5);
  });

  it('treats an untagged issue as page-scoped for backwards compatibility', () => {
    const untagged = calculateHealthScore({
      issues: [{ category: 'METADATA', severity: 'MEDIUM', weight: 2 }],
      pageCount: 1000,
    });
    const tagged = calculateHealthScore({
      issues: [{ category: 'METADATA', severity: 'MEDIUM', weight: 2, scope: 'page' }],
      pageCount: 1000,
    });
    expect(untagged.score).toBe(tagged.score);
  });

  it('names both penalty sources in the explanation', () => {
    const result = calculateHealthScore({
      issues: [
        { category: 'CRAWLABILITY', severity: 'MEDIUM', weight: 2, scope: 'site' },
        { category: 'CRAWLABILITY', severity: 'HIGH', weight: 3, scope: 'page' },
      ],
      pageCount: 100,
    });
    const crawlability = result.factors.find((f) => f.key === 'CRAWLABILITY')!;
    expect(crawlability.explanation).toMatch(/page-level penalty points/);
    expect(crawlability.explanation).toMatch(/site-wide penalty points/);
  });
});
