import { describe, expect, it } from 'vitest';
import { decideContentAction, type ExistingPageSummary } from '../content/decision';
import { buildLinkGraph } from '../links/graph';
import { auditAnchorText, suggestInternalLinks, type LinkCandidatePage } from '../links/suggestions';
import { auditSiteGeo, scoreGeoPage, type GeoPageInput, type GeoSiteContext } from '../geo/audit';
import { validateJsonLd } from '../structured-data/validate';
import { generateFaqSchema, generateOrganizationSchema, toScriptTag } from '../structured-data/generate';
import { evaluateExperiment, summariseActionOutcomes } from '../experiments/evaluate';

const existingPage = (over: Partial<ExistingPageSummary> & { id: string; url: string }): ExistingPageSummary => ({
  title: null, h1: null, metaDescription: null, textContent: null, wordCount: 800,
  pageType: 'ARTICLE', targetKeywords: [], position: null, impressions: 0, clicks: 0,
  ctr: null, clicksTrendPct: null, isIndexable: true, ...over,
});

describe('decideContentAction — the anti-page-spam gate', () => {
  it('improves an existing page rather than creating a competing one', () => {
    const decision = decideContentAction({
      keyword: 'ai workout planner',
      intent: 'COMMERCIAL', funnelStage: 'CONSIDERATION',
      impressions: 5000, clicks: 30, searchVolume: 2000, currentPosition: 14,
      thinContentWords: 300,
      existingPages: [
        existingPage({
          id: 'p1', url: '/ai-workout-planner', title: 'AI Workout Planner',
          targetKeywords: ['ai workout planner'], wordCount: 500, position: 14, impressions: 5000,
        }),
      ],
    });
    expect(decision.decision).toBe('IMPROVE_EXISTING_PAGE');
    expect(decision.targetPage?.url).toBe('/ai-workout-planner');
    expect(decision.suggestedUrl).toBeNull();
  });

  it('refuses to add a page when the query is already cannibalised', () => {
    const decision = decideContentAction({
      keyword: 'workout planner',
      intent: 'COMMERCIAL', funnelStage: 'CONSIDERATION',
      impressions: 4000, clicks: 20, searchVolume: 3000, currentPosition: 9,
      thinContentWords: 300,
      cannibalizingUrls: ['/a', '/b', '/c'],
      existingPages: [existingPage({ id: 'p1', url: '/a', title: 'Workout Planner' })],
    });
    expect(decision.decision).toBe('CONSOLIDATE_CANNIBALISATION');
    expect(decision.cannibalizationRisk).toBe(1);
  });

  it('recommends a CTR rewrite when the page ranks but is under-clicked', () => {
    const decision = decideContentAction({
      keyword: 'gym routine generator',
      intent: 'COMMERCIAL', funnelStage: 'CONSIDERATION',
      impressions: 8000, clicks: 40, searchVolume: 3000, currentPosition: 4,
      thinContentWords: 300,
      existingPages: [
        existingPage({
          id: 'p1', url: '/gym-routine-generator', title: 'Gym Routine Generator',
          targetKeywords: ['gym routine generator'], wordCount: 1800,
          position: 4, impressions: 8000, clicks: 40, ctr: 0.005,
        }),
      ],
    });
    expect(decision.decision).toBe('CTR_OPTIMISATION');
  });

  it('recommends a refresh for a decaying page', () => {
    const decision = decideContentAction({
      keyword: 'best gym routines',
      intent: 'COMMERCIAL', funnelStage: 'CONSIDERATION',
      impressions: 3000, clicks: 50, searchVolume: 2000, currentPosition: 7,
      thinContentWords: 300,
      existingPages: [
        existingPage({
          id: 'p1', url: '/best-gym-routines', title: 'Best Gym Routines',
          targetKeywords: ['best gym routines'], wordCount: 2000,
          position: 7, impressions: 3000, clicks: 50, ctr: 0.05, clicksTrendPct: -45,
        }),
      ],
    });
    expect(decision.decision).toBe('CONTENT_REFRESH');
  });

  it('declines to create anything for an unproven query with no coverage', () => {
    const decision = decideContentAction({
      keyword: 'obscure niche phrase nobody searches',
      intent: 'INFORMATIONAL', funnelStage: 'AWARENESS',
      impressions: 1, clicks: 0, searchVolume: null, currentPosition: null,
      thinContentWords: 300,
      existingPages: [existingPage({ id: 'p1', url: '/unrelated', title: 'Tax Software Reviews' })],
    });
    expect(decision.decision).toBe('NO_ACTION');
    expect(decision.reasoning).toMatch(/demand is unproven/i);
  });

  it('creates a comparison page for an explicitly comparative query with demand', () => {
    const decision = decideContentAction({
      keyword: 'strava vs garmin connect',
      intent: 'COMMERCIAL', funnelStage: 'CONSIDERATION',
      impressions: 900, clicks: 0, searchVolume: 4000, currentPosition: null,
      thinContentWords: 300,
      existingPages: [existingPage({ id: 'p1', url: '/tax', title: 'Tax Software Reviews' })],
    });
    expect(decision.decision).toBe('NEW_COMPARISON_PAGE');
    expect(decision.suggestedUrl).toBe('/strava-vs-garmin-connect');
  });
});

describe('buildLinkGraph', () => {
  const pages = [
    { id: 'home', url: 'https://x.com/', normalizedUrl: 'https://x.com/', title: 'Home', depth: 0, isIndexable: true, wordCount: 500 },
    { id: 'a', url: 'https://x.com/a', normalizedUrl: 'https://x.com/a', title: 'A', depth: 1, isIndexable: true, wordCount: 900 },
    { id: 'b', url: 'https://x.com/b', normalizedUrl: 'https://x.com/b', title: 'B', depth: 1, isIndexable: true, wordCount: 900 },
    { id: 'orphan', url: 'https://x.com/orphan', normalizedUrl: 'https://x.com/orphan', title: 'Orphan', depth: 2, isIndexable: true, wordCount: 900 },
  ];
  const edges = [
    { sourceNormalized: 'https://x.com/', targetNormalized: 'https://x.com/a', anchorText: 'A', isNofollow: false, inMainContent: true },
    { sourceNormalized: 'https://x.com/', targetNormalized: 'https://x.com/b', anchorText: 'B', isNofollow: false, inMainContent: true },
    { sourceNormalized: 'https://x.com/a', targetNormalized: 'https://x.com/b', anchorText: 'B', isNofollow: false, inMainContent: true },
  ];

  it('identifies orphans, hubs and authorities', () => {
    const graph = buildLinkGraph(pages, edges, { homepageNormalized: 'https://x.com/' });
    expect(graph.stats.orphanCount).toBe(1);
    expect(graph.nodes.find((n) => n.id === 'orphan')!.isOrphan).toBe(true);
    expect(graph.nodes.find((n) => n.id === 'home')!.isOrphan).toBe(false);
    // B has two inbound links, A one — B must carry more authority.
    const a = graph.nodes.find((n) => n.id === 'a')!;
    const b = graph.nodes.find((n) => n.id === 'b')!;
    expect(b.authority).toBeGreaterThan(a.authority);
  });

  it('counts disconnected components', () => {
    const graph = buildLinkGraph(pages, edges, { homepageNormalized: 'https://x.com/' });
    expect(graph.stats.components).toBe(2); // the main site plus the orphan
  });

  it('excludes nofollow links from authority flow but keeps them in the graph', () => {
    const nofollowEdges = edges.map((e) => ({ ...e, isNofollow: true }));
    const graph = buildLinkGraph(pages, nofollowEdges, { homepageNormalized: 'https://x.com/' });
    expect(graph.edges).toHaveLength(3);
    const authorities = graph.nodes.map((n) => n.authority);
    expect(new Set(authorities).size).toBe(1); // all equal — no authority flowed
  });
});

describe('suggestInternalLinks', () => {
  const candidate = (over: Partial<LinkCandidatePage> & { id: string; url: string }): LinkCandidatePage => ({
    normalizedUrl: over.url, title: null, h1: null, metaDescription: null, textContent: null,
    wordCount: 800, isIndexable: true, depth: 2, targetKeywords: [], inboundLinks: 0,
    outboundLinks: 5, ...over,
  });

  it('suggests a link whose anchor already appears in the source prose', () => {
    const pages = [
      candidate({
        id: 'source', url: '/guide', title: 'Complete Training Guide', wordCount: 1200, inboundLinks: 10,
        textContent:
          'Training consistently matters most. A good ai workout planner removes the guesswork from ' +
          'programming. Most lifters overcomplicate their weekly split and stall for months.',
      }),
      candidate({
        id: 'target', url: '/ai-workout-planner', title: 'AI Workout Planner',
        targetKeywords: ['ai workout planner'], inboundLinks: 0,
        textContent: 'Our ai workout planner builds a programme around your equipment and schedule.',
      }),
    ];
    const suggestions = suggestInternalLinks(pages, []);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.sourcePageId).toBe('source');
    expect(suggestions[0]!.targetPageId).toBe('target');
    expect(suggestions[0]!.anchorText.toLowerCase()).toBe('ai workout planner');
    expect(suggestions[0]!.contextSnippet).toContain('guesswork');
    expect(suggestions[0]!.reason).toMatch(/orphan/i);
  });

  it('never suggests a link that already exists', () => {
    const pages = [
      candidate({
        id: 'source', url: '/guide', title: 'Guide',
        textContent: 'A good ai workout planner removes the guesswork.',
      }),
      candidate({ id: 'target', url: '/p', title: 'AI Workout Planner', targetKeywords: ['ai workout planner'] }),
    ];
    const suggestions = suggestInternalLinks(pages, [
      { sourceId: 'source', targetId: 'target', anchorText: 'planner' },
    ]);
    expect(suggestions).toHaveLength(0);
  });

  it('skips targets that are already well linked', () => {
    const pages = [
      candidate({ id: 'source', url: '/guide', textContent: 'A good ai workout planner helps.' }),
      candidate({ id: 'target', url: '/p', title: 'AI Workout Planner', targetKeywords: ['ai workout planner'], inboundLinks: 25 }),
    ];
    expect(suggestInternalLinks(pages, [])).toHaveLength(0);
  });
});

describe('auditAnchorText', () => {
  it('flags an over-optimised exact-match anchor profile', () => {
    const target: LinkCandidatePage = {
      id: 'target', url: '/p', normalizedUrl: '/p', title: 'Planner', h1: null, metaDescription: null,
      textContent: null, wordCount: 900, isIndexable: true, depth: 1,
      targetKeywords: ['ai workout planner'], inboundLinks: 8, outboundLinks: 3,
    };
    const links = Array.from({ length: 8 }, (_, i) => ({
      sourceId: `s${i}`, targetId: 'target', anchorText: i < 7 ? 'AI workout planner' : 'read more',
    }));
    const audits = auditAnchorText([target], links);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.severity).toBe('high');
    expect(audits[0]!.exactMatchRatio).toBeGreaterThan(0.7);
  });

  it('stays quiet on a natural anchor profile', () => {
    const target: LinkCandidatePage = {
      id: 'target', url: '/p', normalizedUrl: '/p', title: 'Planner', h1: null, metaDescription: null,
      textContent: null, wordCount: 900, isIndexable: true, depth: 1,
      targetKeywords: ['ai workout planner'], inboundLinks: 6, outboundLinks: 3,
    };
    const links = ['our planner', 'read the guide', 'this tool', 'here', 'learn more', 'ai workout planner'].map(
      (anchor, i) => ({ sourceId: `s${i}`, targetId: 'target', anchorText: anchor }),
    );
    expect(auditAnchorText([target], links)).toHaveLength(0);
  });
});

describe('GEO scoring', () => {
  const site: GeoSiteContext = {
    brandName: 'Acme', domain: 'acme.com', brandDescriptions: ['Acme builds workout software.'],
    hasAboutPage: true, hasContactPage: true, hasAuthorPages: true,
    organizationSchemaFound: true, websiteSchemaFound: true, verifiedFactCount: 4,
    knownEntities: ['Acme', 'Workout Planner'],
  };

  const strongPage: GeoPageInput = {
    id: 'p1', url: 'https://acme.com/planner',
    title: 'AI Workout Planner', h1: 'AI Workout Planner',
    metaDescription: 'What an AI workout planner is and how Acme builds one.',
    textContent:
      'An AI workout planner is a tool that generates a training programme from your goals. ' +
      'Acme built one containing 1,200 exercises. Our data shows 68% of users train 3 times per week. ' +
      'Compared to a static template, an adaptive plan changes weekly. What does it cost? ' +
      'Plans start at $9 per month. Written by Dr Jane Smith, PhD, reviewed by our team. ' +
      'Our research surveyed 4,300 lifters across 12 months using a published methodology.',
    html: '<table><tr><td>x</td></tr></table><ul><li>a</li></ul>',
    wordCount: 900,
    headings: [
      { level: 1, text: 'AI Workout Planner' },
      { level: 2, text: 'What is an AI workout planner?' },
      { level: 2, text: 'How much does it cost?' },
    ],
    schemaTypes: ['Article', 'BreadcrumbList', 'Person'],
    structuredData: [{ '@type': 'Article', author: { '@type': 'Person', name: 'Jane Smith' } }],
    externalLinks: [{ href: 'https://pubmed.ncbi.nlm.nih.gov/12345', anchorText: 'study', isNofollow: false }],
    pageType: 'ARTICLE', isIndexable: true,
  };

  const weakPage: GeoPageInput = {
    ...strongPage, id: 'p2', url: 'https://acme.com/thin',
    title: 'Page', h1: 'Page',
    textContent: 'Some generic filler prose that says very little of substance about anything at all.',
    html: '', wordCount: 200, headings: [{ level: 1, text: 'Page' }],
    schemaTypes: [], structuredData: [], externalLinks: [],
  };

  it('scores a fact-dense, well-structured page above a thin one', () => {
    expect(scoreGeoPage(strongPage, site).score).toBeGreaterThan(scoreGeoPage(weakPage, site).score + 20);
  });

  it('returns a factor per dimension with an explanation', () => {
    const result = scoreGeoPage(strongPage, site);
    expect(result.factors).toHaveLength(11);
    expect(result.factors.every((f) => f.explanation.length > 5)).toBe(true);
    const weights = result.factors.reduce((s, f) => s + f.weight, 0);
    expect(weights).toBeCloseTo(1, 5);
  });

  it('produces actionable findings on a weak page', () => {
    const result = scoreGeoPage(weakPage, site);
    expect(result.findings.length).toBeGreaterThan(2);
    expect(result.findings.every((f) => f.message.length > 20)).toBe(true);
  });

  it('penalises a site with no Organization schema and no About page', () => {
    const withSignals = auditSiteGeo([strongPage], site);
    const withoutSignals = auditSiteGeo([strongPage], {
      ...site, organizationSchemaFound: false, hasAboutPage: false, hasAuthorPages: false,
    });
    expect(withoutSignals.score).toBeLessThan(withSignals.score);
    expect(withoutSignals.findings.some((f) => /Organization schema/i.test(f.message))).toBe(true);
    expect(withoutSignals.summary).toMatch(/not guaranteed ranking factors/i);
  });

  it('handles a site with no auditable pages without throwing', () => {
    const result = auditSiteGeo([], site);
    expect(result.pagesAudited).toBe(0);
    expect(result.summary).toMatch(/crawl the site first/i);
  });
});

describe('structured data', () => {
  it('accepts valid Organization markup', () => {
    const schema = generateOrganizationSchema({
      domain: 'acme.com', protocol: 'https', brandName: 'Acme', siteName: 'Acme',
      logoUrl: 'https://acme.com/logo.png', organizationDescription: 'Workout software.',
      sameAs: ['https://x.com/acme'], language: 'en',
    })!;
    expect(schema.validation.status).toBe('VALID');
    expect(schema.jsonLd['@type']).toBe('Organization');
  });

  it('rejects an Article with no headline and a bad date', () => {
    const result = validateJsonLd({
      '@context': 'https://schema.org', '@type': 'Article', datePublished: 'last tuesday',
    });
    expect(result.status).toBe('INVALID');
    expect(result.issues.some((i) => i.path.endsWith('headline'))).toBe(true);
    expect(result.issues.some((i) => i.path.endsWith('datePublished'))).toBe(true);
  });

  it('rejects an AggregateRating with no review count — no invented ratings', () => {
    const result = validateJsonLd({
      '@context': 'https://schema.org', '@type': 'AggregateRating', ratingValue: 4.8,
    });
    expect(result.status).toBe('INVALID');
    expect(result.issues.some((i) => /reviewCount/.test(i.path))).toBe(true);
  });

  it('validates nodes inside an @graph', () => {
    const result = validateJsonLd({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'Organization', name: 'Acme', url: 'https://acme.com' },
        { '@type': 'WebSite', name: 'Acme', url: 'https://acme.com' },
      ],
    });
    expect(result.types).toContain('Organization');
    expect(result.types).toContain('WebSite');
    expect(result.status).not.toBe('INVALID');
  });

  it('refuses to invent FAQ markup that is not on the page', () => {
    const { schema, declined } = generateFaqSchema({
      url: 'https://acme.com/x', path: '/x', title: 'X', h1: 'X', metaDescription: null,
      textContent: 'Just prose with no questions in it whatsoever.', headings: [{ level: 2, text: 'Overview' }],
      pageType: 'ARTICLE', publishedAt: null, contentUpdatedAt: null, existingSchemaTypes: [],
    });
    expect(schema).toBeNull();
    expect(declined?.reason).toMatch(/will not invent questions/i);
  });

  it('escapes a closing script tag inside the payload', () => {
    const tag = toScriptTag({ '@type': 'Article', headline: 'Bad </script> input' });
    expect(tag).not.toContain('</script>B');
    expect(tag).toContain('<\\/script');
  });
});

describe('evaluateExperiment', () => {
  const days = (n: number, value: number, from = Date.UTC(2026, 0, 1)) =>
    Array.from({ length: n }, (_, i) => ({
      date: new Date(from + i * 86_400_000),
      clicks: value + (i % 3),
      impressions: value * 20,
      ctr: 0.05,
      position: 8,
    }));

  const baseline = { start: new Date(Date.UTC(2026, 0, 1)), end: new Date(Date.UTC(2026, 0, 28)) };
  const measurement = { start: new Date(Date.UTC(2026, 1, 1)), end: new Date(Date.UTC(2026, 2, 15)) };

  it('waits for enough post-change data before concluding anything', () => {
    const result = evaluateExperiment(
      { metric: 'clicks', baseline, measurement, minDays: 28 },
      days(28, 40),
      days(3, 60, Date.UTC(2026, 1, 8)),
      new Date(Date.UTC(2026, 1, 12)),
    );
    expect(result.outcome).toBe('PENDING');
    expect(result.needsMoreData).toBe(true);
  });

  it('labels a large, consistent improvement likely positive without claiming causation', () => {
    const result = evaluateExperiment(
      { metric: 'clicks', baseline, measurement, minDays: 28 },
      days(28, 40),
      days(30, 90, Date.UTC(2026, 1, 8)),
      new Date(Date.UTC(2026, 2, 20)),
    );
    expect(result.outcome).toBe('LIKELY_POSITIVE');
    expect(result.interpretation).toMatch(/correlation, not proof/i);
  });

  it('labels a small change inconclusive rather than a win', () => {
    const result = evaluateExperiment(
      { metric: 'clicks', baseline, measurement, minDays: 28 },
      days(28, 40),
      days(30, 41, Date.UTC(2026, 1, 8)),
      new Date(Date.UTC(2026, 2, 20)),
    );
    expect(result.outcome).toBe('INCONCLUSIVE');
  });

  it('treats a fall in average position as an improvement', () => {
    const worse = days(28, 40).map((d) => ({ ...d, position: 14 }));
    const better = days(30, 40, Date.UTC(2026, 1, 8)).map((d) => ({ ...d, position: 5 }));
    const result = evaluateExperiment(
      { metric: 'position', baseline, measurement, minDays: 28 },
      worse,
      better,
      new Date(Date.UTC(2026, 2, 20)),
    );
    expect(result.outcome).toBe('LIKELY_POSITIVE');
    expect(result.deltaPct).toBeGreaterThan(0);
  });
});

describe('summariseActionOutcomes', () => {
  it('says there is not enough history below three measured results', () => {
    const summary = summariseActionOutcomes([
      { actionType: 'UPDATE_TITLE', outcome: 'LIKELY_POSITIVE', deltaPct: 20 },
      { actionType: 'UPDATE_TITLE', outcome: 'INCONCLUSIVE', deltaPct: 2 },
    ]);
    expect(summary[0]!.learning).toMatch(/not enough history/i);
  });

  it('recommends deprioritising an action type that keeps failing here', () => {
    const summary = summariseActionOutcomes([
      { actionType: 'ADD_INTERNAL_LINKS', outcome: 'LIKELY_NEGATIVE', deltaPct: -20 },
      { actionType: 'ADD_INTERNAL_LINKS', outcome: 'LIKELY_NEGATIVE', deltaPct: -15 },
      { actionType: 'ADD_INTERNAL_LINKS', outcome: 'INCONCLUSIVE', deltaPct: 1 },
      { actionType: 'ADD_INTERNAL_LINKS', outcome: 'LIKELY_POSITIVE', deltaPct: 5 },
    ]);
    expect(summary[0]!.learning).toMatch(/deprioritise/i);
  });
});
