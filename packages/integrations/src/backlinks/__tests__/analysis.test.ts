import { describe, expect, it } from 'vitest';
import { detectSuspiciousLinks, isExactMatchAnchor } from '../analysis';
import type { AnalysableLink, SuspiciousContext } from '../analysis';

const KEYWORDS = new Set(['cheap running shoes', 'best crm software', 'buy widgets online']);
const BRAND = new Set(['ours', 'ours com']);

function context(overrides: Partial<SuspiciousContext> = {}): SuspiciousContext {
  return { keywords: KEYWORDS, brandTerms: BRAND, ...overrides };
}

let counter = 0;
function link(partial: Partial<AnalysableLink> & { referringDomain: string }): AnalysableLink {
  counter += 1;
  return {
    id: `link-${counter}`,
    sourceUrl: `https://${partial.referringDomain}/page-${counter}`,
    targetUrl: 'https://ours.com/shoes',
    anchorText: 'ours',
    isFollow: true,
    firstSeenAt: new Date('2024-05-01T00:00:00Z'),
    ...partial,
  };
}

describe('isExactMatchAnchor', () => {
  it('matches a tracked keyword regardless of case and spacing', () => {
    expect(isExactMatchAnchor('  Cheap Running Shoes ', KEYWORDS, BRAND)).toBe(true);
  });

  it('does not match a brand anchor', () => {
    expect(isExactMatchAnchor('Ours', KEYWORDS, BRAND)).toBe(false);
  });

  it('does not match a bare URL anchor', () => {
    expect(isExactMatchAnchor('https://ours.com/shoes', KEYWORDS, BRAND)).toBe(false);
    expect(isExactMatchAnchor('ours.com/shoes', KEYWORDS, BRAND)).toBe(false);
  });

  it('does not match an anchor that merely contains a keyword', () => {
    expect(isExactMatchAnchor('we reviewed cheap running shoes here', KEYWORDS, BRAND)).toBe(false);
  });

  it('ignores an empty or missing anchor', () => {
    expect(isExactMatchAnchor(null, KEYWORDS, BRAND)).toBe(false);
    expect(isExactMatchAnchor('   ', KEYWORDS, BRAND)).toBe(false);
  });
});

describe('detectSuspiciousLinks', () => {
  it('returns nothing for a natural profile', () => {
    const links = [
      link({ referringDomain: 'techblog.com', anchorText: 'Ours' }),
      link({ referringDomain: 'news.co.uk', anchorText: 'this pricing page' }),
      link({ referringDomain: 'forum.example.org', anchorText: 'https://ours.com/shoes', isFollow: false }),
    ];
    expect(detectSuspiciousLinks(links, context())).toEqual([]);
  });

  it('flags exact-match anchor over-optimisation', () => {
    const links = [
      link({ referringDomain: 'reviewsite.com', anchorText: 'cheap running shoes' }),
      link({ referringDomain: 'reviewsite.com', anchorText: 'best crm software' }),
      link({ referringDomain: 'reviewsite.com', anchorText: 'buy widgets online' }),
      link({ referringDomain: 'reviewsite.com', anchorText: 'Ours' }),
    ];
    const [finding] = detectSuspiciousLinks(links, context());
    expect(finding?.reasons).toContain('EXACT_MATCH_ANCHOR_OVER_OPTIMISATION');
    expect(finding?.severity).toBe('MEDIUM');
    expect(finding?.evidence[0]).toContain('3/4');
  });

  it('ignores money anchors on nofollow links, which pass no equity', () => {
    const links = [
      link({ referringDomain: 'reviewsite.com', anchorText: 'cheap running shoes', isFollow: false }),
      link({ referringDomain: 'reviewsite.com', anchorText: 'best crm software', isFollow: false }),
      link({ referringDomain: 'reviewsite.com', anchorText: 'buy widgets online', isFollow: false }),
      link({ referringDomain: 'reviewsite.com', anchorText: 'ours', isFollow: false }),
    ];
    expect(detectSuspiciousLinks(links, context())).toEqual([]);
  });

  it('does not judge the anchor share of a domain with too few links', () => {
    const links = [
      link({ referringDomain: 'smallblog.com', anchorText: 'cheap running shoes' }),
      link({ referringDomain: 'smallblog.com', anchorText: 'best crm software' }),
    ];
    expect(detectSuspiciousLinks(links, context())).toEqual([]);
  });

  it('flags an abuse-heavy TLD', () => {
    const [finding] = detectSuspiciousLinks([link({ referringDomain: 'randomsite.tk' })], context());
    expect(finding?.reasons).toEqual(['SPAM_TLD']);
    expect(finding?.severity).toBe('LOW');
  });

  it('flags a link-scheme keyword in the hostname', () => {
    const [finding] = detectSuspiciousLinks([link({ referringDomain: 'best-guestpost-network.com' })], context());
    expect(finding?.reasons).toContain('SPAM_DOMAIN_PATTERN');
  });

  it('flags a machine-generated domain shape only on multiple structural signals', () => {
    const generated = detectSuspiciousLinks(
      [link({ referringDomain: 'cheap-shoes-outlet-store-99887.com' })],
      context(),
    );
    expect(generated[0]?.reasons).toContain('SPAM_DOMAIN_PATTERN');

    // One hyphen alone is completely normal and must not fire.
    expect(detectSuspiciousLinks([link({ referringDomain: 'my-blog.com' })], context())).toEqual([]);
  });

  it('flags a sitewide/template placement', () => {
    const links = Array.from({ length: 18 }, () =>
      link({ referringDomain: 'partnerdirectory.com', anchorText: 'ours' }),
    );
    const [finding] = detectSuspiciousLinks(links, context());
    expect(finding?.reasons).toContain('SITEWIDE_LINK');
    expect(finding?.evidence.join(' ')).toContain('18 distinct pages');
  });

  it('does not call many links sitewide when they hit different targets', () => {
    const links = Array.from({ length: 18 }, (_unused, i) =>
      link({
        referringDomain: 'bigmagazine.com',
        anchorText: `story ${i}`,
        targetUrl: `https://ours.com/article-${i}`,
      }),
    );
    expect(detectSuspiciousLinks(links, context())).toEqual([]);
  });

  it('flags a burst of links appearing from one domain at once', () => {
    const links = Array.from({ length: 22 }, (_unused, i) =>
      link({
        referringDomain: 'scraper.example',
        anchorText: `mention ${i}`,
        targetUrl: `https://ours.com/p-${i}`,
        firstSeenAt: new Date(Date.UTC(2024, 4, 1, i)),
      }),
    );
    const [finding] = detectSuspiciousLinks(links, context());
    expect(finding?.reasons).toContain('LINK_BURST');
  });

  it('does not call steady acquisition a burst', () => {
    const links = Array.from({ length: 22 }, (_unused, i) =>
      link({
        referringDomain: 'steadyblog.com',
        anchorText: `mention ${i}`,
        targetUrl: `https://ours.com/p-${i}`,
        firstSeenAt: new Date(Date.UTC(2024, 0, 1 + i * 10)),
      }),
    );
    expect(detectSuspiciousLinks(links, context())).toEqual([]);
  });

  it('escalates severity when several signals stack up', () => {
    const links = Array.from({ length: 6 }, (_unused, i) =>
      link({
        referringDomain: 'buy-backlinks-cheap-now.tk',
        anchorText: i === 0 ? 'ours' : 'cheap running shoes',
      }),
    );
    const [finding] = detectSuspiciousLinks(links, context());
    expect(finding?.severity).toBe('HIGH');
    expect(finding?.reasons).toEqual(
      expect.arrayContaining(['EXACT_MATCH_ANCHOR_OVER_OPTIMISATION', 'SPAM_TLD', 'SPAM_DOMAIN_PATTERN']),
    );
    expect(finding?.linkIds).toHaveLength(6);
  });

  it('honours overridden thresholds', () => {
    const links = [
      link({ referringDomain: 'tiny.com', anchorText: 'cheap running shoes' }),
      link({ referringDomain: 'tiny.com', anchorText: 'ours' }),
    ];
    expect(detectSuspiciousLinks(links, context())).toEqual([]);
    const [finding] = detectSuspiciousLinks(
      links,
      context({ thresholds: { minLinksForAnchorShare: 2, exactMatchAnchorShare: 0.5 } }),
    );
    expect(finding?.reasons).toContain('EXACT_MATCH_ANCHOR_OVER_OPTIMISATION');
  });

  it('groups by referring domain and sorts the worst first', () => {
    const findings = detectSuspiciousLinks(
      [
        link({ referringDomain: 'mildlyodd.xyz' }),
        ...Array.from({ length: 5 }, () =>
          link({ referringDomain: 'pbn-link-farm-1234.tk', anchorText: 'buy widgets online' }),
        ),
      ],
      context(),
    );
    expect(findings).toHaveLength(2);
    expect(findings[0]?.referringDomain).toBe('pbn-link-farm-1234.tk');
    expect(findings[0]?.severity).toBe('HIGH');
    expect(findings[1]?.referringDomain).toBe('mildlyodd.xyz');
  });
});
