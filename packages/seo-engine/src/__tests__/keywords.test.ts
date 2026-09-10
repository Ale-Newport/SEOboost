import { describe, expect, it } from 'vitest';
import {
  compareQueries, findCannibalization, findCtrOpportunities, findDecayingPages, findStrikingDistance,
  inferBusinessValue, inferFunnelStage, inferIntent, estimateGeoPotential,
  type QueryPageAggregate,
} from '../keywords/analysis';
import { clusterKeywords, proposeClusterArchitecture, type ClusterableKeyword } from '../keywords/clustering';

const row = (over: Partial<QueryPageAggregate> & { query: string; page: string }): QueryPageAggregate => ({
  clicks: 0, impressions: 0, ctr: 0, position: 50, ...over,
});

describe('findStrikingDistance', () => {
  it('returns only queries in the 8-20 band with real volume, ranked by upside', () => {
    const results = findStrikingDistance([
      row({ query: 'a', page: '/a', position: 12, impressions: 5000, clicks: 20, ctr: 0.004 }),
      row({ query: 'b', page: '/b', position: 3, impressions: 5000, clicks: 500, ctr: 0.1 }),
      row({ query: 'c', page: '/c', position: 45, impressions: 5000, clicks: 2, ctr: 0.0004 }),
      row({ query: 'd', page: '/d', position: 15, impressions: 5, clicks: 0, ctr: 0 }),
      row({ query: 'e', page: '/e', position: 9, impressions: 20000, clicks: 60, ctr: 0.003 }),
    ]);
    expect(results.map((r) => r.query)).toEqual(['e', 'a']);
    expect(results[0]!.potentialClicks).toBeGreaterThan(results[1]!.potentialClicks);
    expect(results[0]!.reason).toMatch(/top 3/i);
  });
});

describe('findCtrOpportunities', () => {
  it('finds top-10 queries clicking well below the curve', () => {
    const results = findCtrOpportunities([
      row({ query: 'under', page: '/u', position: 3, impressions: 10_000, clicks: 100, ctr: 0.01 }),
      row({ query: 'fine', page: '/f', position: 3, impressions: 10_000, clicks: 1000, ctr: 0.1 }),
      row({ query: 'deep', page: '/d', position: 40, impressions: 10_000, clicks: 5, ctr: 0.0005 }),
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.query).toBe('under');
    expect(results[0]!.potentialClicks).toBeGreaterThan(500);
    expect(results[0]!.reason).toMatch(/title and meta description/i);
  });

  it('respects the minimum impression floor', () => {
    const results = findCtrOpportunities(
      [row({ query: 'tiny', page: '/t', position: 3, impressions: 40, clicks: 0, ctr: 0 })],
      { minImpressions: 100 },
    );
    expect(results).toHaveLength(0);
  });
});

describe('findDecayingPages', () => {
  it('separates ranking loss from demand loss in its explanation', () => {
    const rankingLoss = findDecayingPages({
      previous: [row({ query: 'q1', page: '/p', clicks: 100, impressions: 3000, position: 4 })],
      current: [row({ query: 'q1', page: '/p', clicks: 30, impressions: 3000, position: 11 })],
    });
    expect(rankingLoss).toHaveLength(1);
    expect(rankingLoss[0]!.reason).toMatch(/ranking loss/i);
    expect(rankingLoss[0]!.positionChange).toBeGreaterThan(1.5);

    const demandLoss = findDecayingPages({
      previous: [row({ query: 'q1', page: '/p', clicks: 100, impressions: 4000, position: 4 })],
      current: [row({ query: 'q1', page: '/p', clicks: 40, impressions: 1500, position: 4.1 })],
    });
    expect(demandLoss[0]!.reason).toMatch(/demand|seasonality/i);
  });

  it('lists queries that stopped ranking entirely', () => {
    const results = findDecayingPages({
      previous: [
        row({ query: 'kept', page: '/p', clicks: 60, impressions: 2000, position: 5 }),
        row({ query: 'lost', page: '/p', clicks: 40, impressions: 1500, position: 6 }),
      ],
      current: [row({ query: 'kept', page: '/p', clicks: 20, impressions: 1800, position: 5.2 })],
    });
    expect(results[0]!.lostQueries).toContain('lost');
  });

  it('ignores pages with too little traffic to judge', () => {
    const results = findDecayingPages({
      previous: [row({ query: 'q', page: '/p', clicks: 3, impressions: 100, position: 10 })],
      current: [],
    });
    expect(results).toHaveLength(0);
  });
});

describe('findCannibalization', () => {
  it('flags a query split across pages at comparable positions', () => {
    const results = findCannibalization([
      row({ query: 'workout planner', page: '/a', impressions: 1000, clicks: 30, position: 8 }),
      row({ query: 'workout planner', page: '/b', impressions: 700, clicks: 10, position: 12 }),
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.pages).toHaveLength(2);
    expect(results[0]!.bestPage).toBe('/a');
    expect(results[0]!.recommendation).toContain('/a');
  });

  it('ignores a second page with a negligible impression share', () => {
    const results = findCannibalization([
      row({ query: 'q', page: '/a', impressions: 1000, position: 5 }),
      row({ query: 'q', page: '/b', impressions: 10, position: 60 }),
    ]);
    expect(results).toHaveLength(0);
  });

  it('ignores a query below the impression floor', () => {
    const results = findCannibalization(
      [
        row({ query: 'q', page: '/a', impressions: 10, position: 5 }),
        row({ query: 'q', page: '/b', impressions: 10, position: 6 }),
      ],
      { minImpressions: 50 },
    );
    expect(results).toHaveLength(0);
  });
});

describe('compareQueries', () => {
  it('classifies new, lost, improved and declined queries', () => {
    const growth = compareQueries({
      previous: [
        row({ query: 'improved', page: '/a', clicks: 10, impressions: 100, position: 12 }),
        row({ query: 'declined', page: '/b', clicks: 50, impressions: 500, position: 4 }),
        row({ query: 'lost', page: '/c', clicks: 5, impressions: 50, position: 8 }),
      ],
      current: [
        row({ query: 'improved', page: '/a', clicks: 40, impressions: 300, position: 4 }),
        row({ query: 'declined', page: '/b', clicks: 10, impressions: 500, position: 14 }),
        row({ query: 'new', page: '/d', clicks: 12, impressions: 120, position: 6 }),
      ],
    });
    const byQuery = new Map(growth.map((g) => [g.query, g.status]));
    expect(byQuery.get('improved')).toBe('improved');
    expect(byQuery.get('declined')).toBe('declined');
    expect(byQuery.get('lost')).toBe('lost');
    expect(byQuery.get('new')).toBe('new');
  });
});

describe('intent inference', () => {
  it('classifies queries by wording', () => {
    expect(inferIntent('buy running shoes')).toBe('TRANSACTIONAL');
    expect(inferIntent('best workout apps')).toBe('COMMERCIAL');
    expect(inferIntent('how to build a gym routine')).toBe('INFORMATIONAL');
    expect(inferIntent('gyms near me')).toBe('LOCAL');
    expect(inferIntent('acme')).toBe('NAVIGATIONAL');
  });

  it('maps intent onto funnel stages', () => {
    expect(inferFunnelStage('INFORMATIONAL')).toBe('AWARENESS');
    expect(inferFunnelStage('COMMERCIAL')).toBe('CONSIDERATION');
    expect(inferFunnelStage('TRANSACTIONAL')).toBe('DECISION');
  });

  it('rates commercial intent as more valuable than informational', () => {
    expect(inferBusinessValue('buy workout app', 'TRANSACTIONAL')).toBeGreaterThan(
      inferBusinessValue('what is a workout', 'INFORMATIONAL'),
    );
  });

  it('rates comparison-style queries as higher AI-search potential', () => {
    expect(estimateGeoPotential('best workout app vs competitor', 'COMMERCIAL')).toBeGreaterThan(
      estimateGeoPotential('acme', 'NAVIGATIONAL'),
    );
  });
});

describe('clusterKeywords', () => {
  const kw = (id: string, keyword: string, impressions = 100): ClusterableKeyword => ({
    id, keyword, normalized: keyword, impressions, clicks: 0, searchVolume: null,
    position: 10, intent: 'INFORMATIONAL', rankingUrl: null,
  });

  it('groups lexically related keywords and separates unrelated ones', () => {
    const clusters = clusterKeywords([
      kw('1', 'ai workout planner', 500),
      kw('2', 'workout planner app'),
      kw('3', 'personalized workout planner'),
      kw('4', 'tax filing software'),
      kw('5', 'tax return software'),
    ]);
    const workoutCluster = clusters.find((c) => c.keywords.some((k) => k.includes('workout')));
    const taxCluster = clusters.find((c) => c.keywords.some((k) => k.includes('tax')));
    expect(workoutCluster).toBeDefined();
    expect(taxCluster).toBeDefined();
    expect(workoutCluster!.keywordIds.sort()).toEqual(['1', '2', '3']);
    expect(taxCluster!.keywordIds.sort()).toEqual(['4', '5']);
  });

  it('reports the URL spread that signals fragmentation', () => {
    const clusters = clusterKeywords([
      { ...kw('1', 'workout planner'), rankingUrl: '/a' },
      { ...kw('2', 'workout planner app'), rankingUrl: '/b' },
      { ...kw('3', 'best workout planner'), rankingUrl: '/c' },
    ]);
    expect(clusters[0]!.urlSpread).toBe(3);
  });

  it('returns an empty result for no input', () => {
    expect(clusterKeywords([])).toEqual([]);
  });
});

describe('proposeClusterArchitecture', () => {
  it('refuses to propose pages that already exist', () => {
    const cluster = clusterKeywords([
      { id: '1', keyword: 'workout planner', normalized: 'workout planner', impressions: 900, clicks: 0, searchVolume: null, position: 5, intent: 'INFORMATIONAL', rankingUrl: '/planner' },
      { id: '2', keyword: 'ai workout planner', normalized: 'ai workout planner', impressions: 400, clicks: 0, searchVolume: null, position: 12, intent: 'INFORMATIONAL', rankingUrl: '/planner' },
    ])[0]!;

    const architecture = proposeClusterArchitecture(cluster, [
      { url: '/planner', title: 'Workout Planner', targetKeywords: ['workout planner'] },
      { url: '/ai-planner', title: 'AI Workout Planner', targetKeywords: ['ai workout planner'] },
    ]);

    expect(architecture.pillar.exists).toBe(true);
    expect(architecture.supporting.every((s) => s.exists)).toBe(true);
  });

  it('warns when the cluster is already fragmented across URLs', () => {
    const cluster = clusterKeywords([
      { id: '1', keyword: 'workout planner', normalized: 'workout planner', impressions: 500, clicks: 0, searchVolume: null, position: 5, intent: 'INFORMATIONAL', rankingUrl: '/a' },
      { id: '2', keyword: 'workout planner app', normalized: 'workout planner app', impressions: 400, clicks: 0, searchVolume: null, position: 9, intent: 'INFORMATIONAL', rankingUrl: '/b' },
      { id: '3', keyword: 'best workout planner', normalized: 'best workout planner', impressions: 300, clicks: 0, searchVolume: null, position: 11, intent: 'INFORMATIONAL', rankingUrl: '/c' },
      { id: '4', keyword: 'free workout planner', normalized: 'free workout planner', impressions: 200, clicks: 0, searchVolume: null, position: 14, intent: 'INFORMATIONAL', rankingUrl: '/d' },
    ])[0]!;

    const architecture = proposeClusterArchitecture(cluster, []);
    expect(architecture.cannibalizationRisk).toBe('high');
    expect(architecture.notes).toMatch(/consolidate/i);
  });
});
