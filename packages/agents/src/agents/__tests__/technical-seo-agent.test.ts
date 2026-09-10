import { describe, expect, it } from 'vitest';
import {
  clusterEffort,
  groupTechnicalIssues,
  type ClusterableIssue,
} from '../technical-seo-agent';
import { pluralise } from '../shared';

/**
 * Fixtures only — no database, no network. The grouping logic is the part that decides what a
 * user is asked to approve, so it is tested in isolation from every I/O concern.
 */
function issue(overrides: Partial<ClusterableIssue> & Pick<ClusterableIssue, 'id' | 'ruleId'>): ClusterableIssue {
  return {
    title: 'Internal link points to a redirect',
    category: 'LINKS',
    severity: 'MEDIUM',
    url: `https://example.com/${overrides.id}`,
    pageId: `page-${overrides.id}`,
    recommendation: 'Point the link at the final destination.',
    autoFixable: true,
    estimatedImpact: 0.45,
    confidence: 0.9,
    weight: 1.5,
    ...overrides,
  };
}

describe('groupTechnicalIssues', () => {
  it('collapses many instances of one rule into a single cluster', () => {
    const issues = Array.from({ length: 42 }, (_, index) => issue({ id: `i${index}`, ruleId: 'INTERNAL_LINK_TO_REDIRECT' }));

    const [cluster] = groupTechnicalIssues(issues);

    expect(cluster).toBeDefined();
    expect(cluster?.count).toBe(42);
    expect(cluster?.issueIds).toHaveLength(42);
    expect(cluster?.headline).toBe('42 internal links point at redirects');
  });

  it('uses the singular phrasing for a single instance', () => {
    const [cluster] = groupTechnicalIssues([issue({ id: 'only', ruleId: 'INTERNAL_LINK_TO_REDIRECT' })]);
    expect(cluster?.headline).toBe('1 internal link points at redirects');
  });

  it('falls back to a generic headline for a rule with no phrase', () => {
    const [cluster] = groupTechnicalIssues([
      issue({ id: 'a', ruleId: 'SOME_UNKNOWN_RULE', title: 'Something unusual' }),
      issue({ id: 'b', ruleId: 'SOME_UNKNOWN_RULE', title: 'Something unusual' }),
    ]);
    expect(cluster?.headline).toBe('2 pages: something unusual');
  });

  it('orders clusters by severity first, then by accumulated impact', () => {
    const clusters = groupTechnicalIssues([
      ...Array.from({ length: 30 }, (_, index) => issue({ id: `low${index}`, ruleId: 'LOW_INTERNAL_LINKS', severity: 'LOW', estimatedImpact: 0.2 })),
      issue({ id: 'crit', ruleId: 'HTTP_5XX', severity: 'CRITICAL', estimatedImpact: 1, weight: 5 }),
      ...Array.from({ length: 3 }, (_, index) => issue({ id: `med${index}`, ruleId: 'REDIRECT_CHAIN', severity: 'MEDIUM' })),
    ]);

    expect(clusters.map((cluster) => cluster.ruleId)).toEqual(['HTTP_5XX', 'REDIRECT_CHAIN', 'LOW_INTERNAL_LINKS']);
  });

  it('takes the worst severity present in a rule group', () => {
    const [cluster] = groupTechnicalIssues([
      issue({ id: 'a', ruleId: 'NOINDEX_PAGE', severity: 'MEDIUM' }),
      issue({ id: 'b', ruleId: 'NOINDEX_PAGE', severity: 'CRITICAL' }),
      issue({ id: 'c', ruleId: 'NOINDEX_PAGE', severity: 'LOW' }),
    ]);
    expect(cluster?.severity).toBe('CRITICAL');
  });

  it('marks a cluster fully auto-fixable only when every instance is', () => {
    const mixed = groupTechnicalIssues([
      issue({ id: 'a', ruleId: 'REDIRECT_CHAIN', autoFixable: true }),
      issue({ id: 'b', ruleId: 'REDIRECT_CHAIN', autoFixable: false }),
    ]);
    expect(mixed[0]?.fullyAutoFixable).toBe(false);
    expect(mixed[0]?.autoFixableCount).toBe(1);

    const clean = groupTechnicalIssues([
      issue({ id: 'a', ruleId: 'REDIRECT_CHAIN', autoFixable: true }),
      issue({ id: 'b', ruleId: 'REDIRECT_CHAIN', autoFixable: true }),
    ]);
    expect(clean[0]?.fullyAutoFixable).toBe(true);
  });

  it('deduplicates and caps the sampled URLs but keeps every issue id', () => {
    const issues = Array.from({ length: 60 }, (_, index) =>
      issue({ id: `i${index}`, ruleId: 'MISSING_TITLE', url: index < 5 ? 'https://example.com/same' : `https://example.com/${index}` }),
    );
    const [cluster] = groupTechnicalIssues(issues);

    expect(cluster?.issueIds).toHaveLength(60);
    expect(cluster?.urls.length).toBeLessThanOrEqual(25);
    expect(new Set(cluster?.urls).size).toBe(cluster?.urls.length);
  });

  it('ignores issues with no URL when sampling, without dropping them from the count', () => {
    const [cluster] = groupTechnicalIssues([
      issue({ id: 'a', ruleId: 'MISSING_SITEMAP', url: null, pageId: null }),
      issue({ id: 'b', ruleId: 'MISSING_SITEMAP', url: null, pageId: null }),
    ]);
    expect(cluster?.count).toBe(2);
    expect(cluster?.urls).toEqual([]);
    expect(cluster?.pageIds).toEqual([]);
  });

  it('scores impact with diminishing returns rather than linearly in the count', () => {
    const ten = groupTechnicalIssues(
      Array.from({ length: 10 }, (_, index) => issue({ id: `i${index}`, ruleId: 'MISSING_TITLE' })),
    )[0];
    const hundred = groupTechnicalIssues(
      Array.from({ length: 100 }, (_, index) => issue({ id: `i${index}`, ruleId: 'MISSING_TITLE' })),
    )[0];

    expect(hundred?.impact).toBeGreaterThan(ten?.impact ?? 0);
    // 10× the issues must not be 10× the impact, or a long tail would always outrank a crisis.
    expect(hundred?.impact ?? 0).toBeLessThan((ten?.impact ?? 0) * 10);
    expect(hundred?.impact ?? 0).toBeLessThanOrEqual(1);
  });

  it('returns nothing for no issues', () => {
    expect(groupTechnicalIssues([])).toEqual([]);
  });
});

describe('clusterEffort', () => {
  it('keeps machine-applicable fixes cheap however many instances there are', () => {
    expect(clusterEffort(1, true)).toBe(1);
    expect(clusterEffort(150, true)).toBe(1);
    expect(clusterEffort(500, true)).toBe(2);
  });

  it('scales manual work with the number of URLs a person must touch', () => {
    expect(clusterEffort(2, false)).toBe(2);
    expect(clusterEffort(15, false)).toBe(3);
    expect(clusterEffort(60, false)).toBe(4);
    expect(clusterEffort(500, false)).toBe(5);
  });
});

describe('pluralise', () => {
  it('leaves the singular alone for exactly one', () => {
    expect(pluralise(1, 'fix')).toBe('fix');
    expect(pluralise(1, 'opportunity')).toBe('opportunity');
  });

  it('handles the sibilant and -y cases that a bare +s gets wrong', () => {
    expect(pluralise(8, 'fix')).toBe('fixes');
    expect(pluralise(3, 'opportunity')).toBe('opportunities');
    expect(pluralise(2, 'match')).toBe('matches');
    expect(pluralise(2, 'class')).toBe('classes');
  });

  it('keeps -ey words intact rather than mangling them', () => {
    expect(pluralise(2, 'survey')).toBe('surveys');
  });

  it('still honours an explicit plural', () => {
    expect(pluralise(2, 'page', 'pages')).toBe('pages');
  });

  it('falls back to +s for regular nouns', () => {
    expect(pluralise(0, 'issue')).toBe('issues');
    expect(pluralise(5, 'link')).toBe('links');
  });
});
