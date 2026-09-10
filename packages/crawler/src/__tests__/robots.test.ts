/**
 * robots.txt evaluation. `evaluateRobots` is the pure half of the module — same rules, same
 * user-agent matching, no fetch — so the crawl's allow/deny behaviour is testable offline.
 */

import { describe, expect, it } from 'vitest';
import { evaluateRobots } from '../robots';

const ROBOTS_URL = 'https://example.com/robots.txt';
const UA = 'SEO-OS-Bot/1.0';

const BODY = `# example robots
User-agent: *
Disallow: /admin/
Disallow: /cart
Allow: /admin/public
Crawl-delay: 2

User-agent: BadBot
Disallow: /

Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/sitemap-news.xml
`;

describe('evaluateRobots', () => {
  const robots = evaluateRobots(ROBOTS_URL, BODY, UA);

  it('allows anything the file does not mention', () => {
    expect(robots.isAllowed('https://example.com/')).toBe(true);
    expect(robots.isAllowed('https://example.com/blog/post')).toBe(true);
  });

  it('denies disallowed prefixes for our user-agent', () => {
    expect(robots.isAllowed('https://example.com/admin/secret')).toBe(false);
    expect(robots.isAllowed('https://example.com/cart')).toBe(false);
    expect(robots.isAllowed('https://example.com/cart/checkout')).toBe(false);
  });

  it('honours a more specific Allow inside a disallowed directory', () => {
    expect(robots.isAllowed('https://example.com/admin/public')).toBe(true);
  });

  it('reads the crawl-delay for our user-agent', () => {
    expect(robots.crawlDelay).toBe(2);
  });

  it('collects every declared sitemap', () => {
    expect(robots.sitemaps).toEqual([
      'https://example.com/sitemap.xml',
      'https://example.com/sitemap-news.xml',
    ]);
  });

  it('reports the file as found with its origin', () => {
    expect(robots.found).toBe(true);
    expect(robots.origin).toBe('https://example.com');
    expect(robots.error).toBeNull();
  });

  it('applies the group matching our user-agent, not another bot’s', () => {
    // `BadBot` is disallowed everywhere; we are not BadBot, so the wildcard group applies.
    expect(robots.isAllowed('https://example.com/anything')).toBe(true);
    const asBadBot = evaluateRobots(ROBOTS_URL, BODY, 'BadBot');
    expect(asBadBot.isAllowed('https://example.com/anything')).toBe(false);
  });

  it('allows URLs on other hosts, which this file does not govern', () => {
    expect(robots.isAllowed('https://other.example.org/admin/secret')).toBe(true);
  });
});

describe('evaluateRobots — permissive fallbacks', () => {
  it('allows everything when the file is empty', () => {
    const robots = evaluateRobots(ROBOTS_URL, '', UA);
    expect(robots.found).toBe(false);
    expect(robots.isAllowed('https://example.com/admin/secret')).toBe(true);
    expect(robots.crawlDelay).toBeNull();
  });

  it('allows everything when the file blocks nothing', () => {
    const robots = evaluateRobots(ROBOTS_URL, 'User-agent: *\nDisallow:\n', UA);
    expect(robots.isAllowed('https://example.com/admin/secret')).toBe(true);
  });

  it('blocks the whole site when the wildcard group disallows the root', () => {
    const robots = evaluateRobots(ROBOTS_URL, 'User-agent: *\nDisallow: /\n', UA);
    expect(robots.isAllowed('https://example.com/')).toBe(false);
    expect(robots.isAllowed('https://example.com/blog')).toBe(false);
  });

  it('supports wildcard and end-of-URL patterns', () => {
    const robots = evaluateRobots(
      ROBOTS_URL,
      'User-agent: *\nDisallow: /*?sessionid=\nDisallow: /*.pdf$\n',
      UA,
    );
    expect(robots.isAllowed('https://example.com/page?sessionid=42')).toBe(false);
    expect(robots.isAllowed('https://example.com/files/report.pdf')).toBe(false);
    expect(robots.isAllowed('https://example.com/files/report.pdf.html')).toBe(true);
  });
});
