import { describe, expect, it } from 'vitest';
import { planActionsToProposals, type PlanHorizon, type PlanItem } from '../seo-manager-agent';

const ALLOWED = [
  'FIX_TECHNICAL_ISSUE',
  'UPDATE_TITLE',
  'UPDATE_META_DESCRIPTION',
  'UPDATE_CONTENT',
  'CREATE_CONTENT_BRIEF',
  'ADD_INTERNAL_LINKS',
  'ADD_STRUCTURED_DATA',
  'REFRESH_CONTENT',
  'CONSOLIDATE_PAGES',
  'SUBMIT_URL_INDEXING',
  'GEO_IMPROVEMENT',
] as const;

function item(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    title: 'Fix the redirect chains',
    actionType: 'FIX_TECHNICAL_ISSUE',
    rationale: '42 internal links point at redirects.',
    expectedOutcome: 'Crawl budget stops being spent on hops.',
    effort: 'LOW',
    impact: 'MEDIUM',
    owner: 'AUTOMATED',
    targetUrls: ['https://example.com/a'],
    dependsOn: null,
    ...overrides,
  };
}

function plan(overrides: Partial<Record<PlanHorizon, PlanItem[]>> = {}): Record<PlanHorizon, PlanItem[]> {
  return { today: [], thisWeek: [], thisMonth: [], ...overrides };
}

describe('planActionsToProposals', () => {
  it('converts plan items in horizon order and decays confidence with the horizon', () => {
    const { accepted } = planActionsToProposals(
      plan({
        thisMonth: [item({ title: 'Month item' })],
        today: [item({ title: 'Today item' })],
        thisWeek: [item({ title: 'Week item' })],
      }),
      { allowedActionTypes: ALLOWED },
    );

    expect(accepted.map((action) => action.title)).toEqual(['Today item', 'Week item', 'Month item']);
    expect(accepted[0]?.confidence).toBeGreaterThan(accepted[1]?.confidence ?? 1);
    expect(accepted[1]?.confidence).toBeGreaterThan(accepted[2]?.confidence ?? 1);
  });

  it('rejects action types the manager may not queue, and says so', () => {
    const { accepted, rejected } = planActionsToProposals(
      plan({
        today: [
          item({ title: 'Publish the new guide', actionType: 'PUBLISH_CONTENT' }),
          item({ title: 'Redirect the old URL', actionType: 'CREATE_REDIRECT' }),
          item({ title: 'Something else entirely', actionType: 'OTHER' }),
          item({ title: 'Fix redirects' }),
        ],
      }),
      { allowedActionTypes: ALLOWED },
    );

    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.type).toBe('FIX_TECHNICAL_ISSUE');
    expect(rejected).toHaveLength(3);
    expect(rejected.map((entry) => entry.title)).toContain('Publish the new guide');
    expect(rejected[0]?.reason).toContain('PUBLISH_CONTENT');
  });

  it('marks anything not owned by automation as non-executable', () => {
    const { accepted } = planActionsToProposals(
      plan({
        today: [
          item({ title: 'Automated fix', owner: 'AUTOMATED' }),
          item({ title: 'Needs review', owner: 'HUMAN_REVIEW' }),
          item({ title: 'Human only', owner: 'HUMAN_ONLY' }),
        ],
      }),
      { allowedActionTypes: ALLOWED },
    );

    expect(accepted.map((action) => action.executable)).toEqual([true, false, false]);
  });

  it('maps effort and impact onto the priority formula scales', () => {
    const { accepted } = planActionsToProposals(
      plan({
        today: [
          item({ title: 'Cheap and valuable', effort: 'LOW', impact: 'HIGH' }),
          item({ title: 'Expensive and marginal', effort: 'HIGH', impact: 'LOW' }),
        ],
      }),
      { allowedActionTypes: ALLOWED },
    );

    expect(accepted[0]?.effort).toBe(1);
    expect(accepted[0]?.impact).toBeCloseTo(0.75);
    expect(accepted[1]?.effort).toBe(5);
    expect(accepted[1]?.impact).toBeCloseTo(0.3);
  });

  it('drops duplicates of the same action type and title', () => {
    const { accepted, rejected } = planActionsToProposals(
      plan({
        today: [item({ title: 'Fix the redirect chains' })],
        thisWeek: [item({ title: 'fix the redirect  chains' })],
      }),
      { allowedActionTypes: ALLOWED },
    );

    expect(accepted).toHaveLength(1);
    expect(rejected[0]?.reason).toContain('Duplicate');
  });

  it('keeps the same title under a different action type', () => {
    const { accepted } = planActionsToProposals(
      plan({
        today: [
          item({ title: 'Improve the pricing page', actionType: 'UPDATE_CONTENT' }),
          item({ title: 'Improve the pricing page', actionType: 'UPDATE_TITLE' }),
        ],
      }),
      { allowedActionTypes: ALLOWED },
    );

    expect(accepted).toHaveLength(2);
  });

  it('enforces the per-run action cap and reports what it left out', () => {
    const items = Array.from({ length: 8 }, (_, index) => item({ title: `Item ${index}` }));
    const { accepted, rejected } = planActionsToProposals(plan({ today: items }), {
      allowedActionTypes: ALLOWED,
      maxActions: 3,
    });

    expect(accepted).toHaveLength(3);
    expect(rejected).toHaveLength(5);
    expect(rejected[0]?.reason).toContain('3-action cap');
  });

  it('rejects untitled items rather than creating an action with no name', () => {
    const { accepted, rejected } = planActionsToProposals(plan({ today: [item({ title: '   ' })] }), {
      allowedActionTypes: ALLOWED,
    });

    expect(accepted).toHaveLength(0);
    expect(rejected[0]?.reason).toContain('no title');
  });

  it('carries the rationale, expected outcome, dependency and target URLs through', () => {
    const { accepted } = planActionsToProposals(
      plan({
        thisWeek: [
          item({
            title: 'Consolidate the duplicate guides',
            actionType: 'CONSOLIDATE_PAGES',
            rationale: 'Three URLs split the same query.',
            expectedOutcome: 'One page holds the relevance.',
            dependsOn: 'Fix the redirect chains',
            targetUrls: ['https://example.com/a', 'https://example.com/b'],
          }),
        ],
      }),
      { allowedActionTypes: ALLOWED },
    );

    const action = accepted[0];
    expect(action?.horizon).toBe('thisWeek');
    expect(action?.reasoning).toBe('Three URLs split the same query. Expected outcome: One page holds the relevance.');
    expect(action?.dependsOn).toBe('Fix the redirect chains');
    expect(action?.affectedUrls).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('returns empty results for an empty plan', () => {
    const { accepted, rejected } = planActionsToProposals(plan(), { allowedActionTypes: ALLOWED });
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([]);
  });
});
