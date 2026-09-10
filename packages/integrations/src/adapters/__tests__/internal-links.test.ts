import { describe, expect, it } from 'vitest';
import { insertInternalLinks } from '../apply';

/**
 * The link inserter rewrites a customer's live page body, so the invariants below are the
 * difference between a helpful internal link and a broken page: no nested anchors, no
 * links dropped into headings or code, and never more than one link per anchor.
 */

const LINK = { anchor: 'technical SEO', href: '/guides/technical-seo' };

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('insertInternalLinks — HTML', () => {
  it('links the first occurrence and leaves later ones alone', () => {
    const body = '<p>We do technical SEO. Our technical SEO team is large. More technical SEO.</p>';
    const result = insertInternalLinks(body, [LINK]);

    expect(result.inserted).toHaveLength(1);
    expect(countOccurrences(result.body, '<a href="/guides/technical-seo">')).toBe(1);
    expect(result.body).toContain('<p>We do <a href="/guides/technical-seo">technical SEO</a>.');
    // The untouched mentions survive verbatim.
    expect(result.body).toContain('Our technical SEO team is large.');
    expect(result.body).toContain('More technical SEO.</p>');
  });

  it('never nests an anchor inside an existing link', () => {
    const body = '<p>Read our <a href="/old">technical SEO</a> guide.</p>';
    const result = insertInternalLinks(body, [LINK]);

    expect(result.inserted).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('NOT_FOUND');
    expect(result.body).toBe(body);
  });

  it('links a later occurrence when the first one is inside an existing link', () => {
    const body = '<p><a href="/old">technical SEO</a> matters. Learn technical SEO with us.</p>';
    const result = insertInternalLinks(body, [LINK]);

    expect(result.inserted).toHaveLength(1);
    expect(result.body).toContain('<a href="/old">technical SEO</a> matters.');
    expect(result.body).toContain('Learn <a href="/guides/technical-seo">technical SEO</a> with us.');
  });

  it('never touches text inside a heading', () => {
    const body = '<h2>technical SEO basics</h2><p>Nothing else here.</p>';
    const result = insertInternalLinks(body, [LINK]);

    expect(result.inserted).toHaveLength(0);
    expect(result.body).toBe(body);
  });

  it('links body text even when the same phrase appears in a heading first', () => {
    const body = '<h2>Technical SEO basics</h2><p>Our technical SEO service is thorough.</p>';
    const result = insertInternalLinks(body, [LINK]);

    expect(result.body).toContain('<h2>Technical SEO basics</h2>');
    expect(result.body).toContain('<p>Our <a href="/guides/technical-seo">technical SEO</a> service is thorough.</p>');
  });

  it('ignores matches inside tag attributes, comments, script, style, pre and code', () => {
    const body = [
      '<img alt="technical SEO" src="/a.png">',
      '<!-- technical SEO note -->',
      '<script>var x = "technical SEO";</script>',
      '<style>/* technical SEO */</style>',
      '<pre>technical SEO</pre>',
      '<code>technical SEO</code>',
    ].join('');
    const result = insertInternalLinks(body, [LINK]);

    expect(result.inserted).toHaveLength(0);
    expect(result.body).toBe(body);
  });

  it('preserves the document casing of the matched text', () => {
    const body = '<p>Great Technical SEO wins.</p>';
    const result = insertInternalLinks(body, [LINK]);
    expect(result.body).toContain('<a href="/guides/technical-seo">Technical SEO</a>');
  });

  it('respects word boundaries so a substring is not linked', () => {
    const body = '<p>The SEOs discussed aSEO and SEO-ish topics.</p>';
    const result = insertInternalLinks(body, [{ anchor: 'SEO', href: '/seo' }]);
    expect(result.inserted).toHaveLength(0);
    expect(result.body).toBe(body);
  });

  it('matches an anchor split across a line break', () => {
    const body = '<p>We handle technical\n  SEO for teams.</p>';
    const result = insertInternalLinks(body, [LINK]);
    expect(result.inserted).toHaveLength(1);
    expect(result.body).toContain('<a href="/guides/technical-seo">technical\n  SEO</a>');
  });

  it('inserts several distinct links, one each', () => {
    const body = '<p>We cover technical SEO, content strategy and link building. Also technical SEO again.</p>';
    const result = insertInternalLinks(body, [
      LINK,
      { anchor: 'content strategy', href: '/guides/content-strategy' },
      { anchor: 'link building', href: '/guides/link-building', title: 'Link building guide' },
    ]);

    expect(result.inserted).toHaveLength(3);
    expect(countOccurrences(result.body, '<a href="/guides/technical-seo">')).toBe(1);
    expect(result.body).toContain('<a href="/guides/content-strategy">content strategy</a>');
    expect(result.body).toContain('<a href="/guides/link-building" title="Link building guide">link building</a>');
  });

  it('skips a duplicate anchor in the same request', () => {
    const body = '<p>technical SEO here, technical SEO there.</p>';
    const result = insertInternalLinks(body, [LINK, { anchor: 'Technical SEO', href: '/other' }]);

    expect(result.inserted).toHaveLength(1);
    expect(result.skipped.map((s) => s.reason)).toEqual(['DUPLICATE_ANCHOR']);
    expect(countOccurrences(result.body, '<a ')).toBe(1);
  });

  it('skips a target the page already links to', () => {
    const body = '<p>See the <a href="/guides/technical-seo">guide</a>. We love technical SEO.</p>';
    const result = insertInternalLinks(body, [LINK]);

    expect(result.inserted).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('ALREADY_LINKED');
    expect(result.body).toBe(body);
  });

  it('reports an unfindable anchor rather than inventing a location', () => {
    const body = '<p>Nothing relevant here.</p>';
    const result = insertInternalLinks(body, [LINK]);
    expect(result.inserted).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('NOT_FOUND');
    expect(result.body).toBe(body);
  });

  it('rejects an empty anchor or href', () => {
    const body = '<p>technical SEO.</p>';
    const result = insertInternalLinks(body, [
      { anchor: '   ', href: '/x' },
      { anchor: 'technical SEO', href: '' },
    ]);
    expect(result.inserted).toHaveLength(0);
    expect(result.skipped.map((s) => s.reason)).toEqual(['INVALID', 'INVALID']);
    expect(result.body).toBe(body);
  });

  it('escapes the href and title it writes into the markup', () => {
    const body = '<p>Read about technical SEO.</p>';
    const result = insertInternalLinks(body, [
      { anchor: 'technical SEO', href: '/search?a=1&b="2"', title: 'A & B' },
    ]);
    expect(result.body).toContain('href="/search?a=1&amp;b=&quot;2&quot;"');
    expect(result.body).toContain('title="A &amp; B"');
  });

  it('does not double-link on a second pass over its own output', () => {
    const body = '<p>We do technical SEO and more technical SEO.</p>';
    const once = insertInternalLinks(body, [LINK]);
    const twice = insertInternalLinks(once.body, [LINK]);

    expect(twice.inserted).toHaveLength(0);
    expect(twice.body).toBe(once.body);
    expect(countOccurrences(twice.body, '<a href="/guides/technical-seo">')).toBe(1);
  });
});

describe('insertInternalLinks — Markdown', () => {
  it('inserts a Markdown link at the first prose occurrence', () => {
    const body = 'We do technical SEO daily. More technical SEO later.';
    const result = insertInternalLinks(body, [LINK], 'markdown');

    expect(result.inserted).toHaveLength(1);
    expect(result.body).toBe('We do [technical SEO](/guides/technical-seo) daily. More technical SEO later.');
  });

  it('never links inside an ATX heading', () => {
    const body = '## technical SEO\n\nNothing else.';
    const result = insertInternalLinks(body, [LINK], 'markdown');
    expect(result.inserted).toHaveLength(0);
    expect(result.body).toBe(body);
  });

  it('never links inside a setext heading', () => {
    const body = 'technical SEO\n=============\n\nNothing else.';
    const result = insertInternalLinks(body, [LINK], 'markdown');
    expect(result.inserted).toHaveLength(0);
    expect(result.body).toBe(body);
  });

  it('never links inside an existing Markdown link', () => {
    const body = 'Read [technical SEO](/old) now.';
    const result = insertInternalLinks(body, [LINK], 'markdown');
    expect(result.inserted).toHaveLength(0);
    expect(result.body).toBe(body);
  });

  it('never links inside fenced or inline code', () => {
    const body = '```\ntechnical SEO\n```\n\nAnd `technical SEO` inline.';
    const result = insertInternalLinks(body, [LINK], 'markdown');
    expect(result.inserted).toHaveLength(0);
    expect(result.body).toBe(body);
  });

  it('links prose that follows a code block', () => {
    const body = '```\nconst x = 1;\n```\n\nOur technical SEO audit is thorough.';
    const result = insertInternalLinks(body, [LINK], 'markdown');
    expect(result.inserted).toHaveLength(1);
    expect(result.body).toContain('Our [technical SEO](/guides/technical-seo) audit is thorough.');
    expect(result.body).toContain('```\nconst x = 1;\n```');
  });

  it('skips a target already linked elsewhere in the document', () => {
    const body = 'See the [guide](/guides/technical-seo). We love technical SEO.';
    const result = insertInternalLinks(body, [LINK], 'markdown');
    expect(result.skipped[0]?.reason).toBe('ALREADY_LINKED');
    expect(result.body).toBe(body);
  });

  it('writes a Markdown title when one is supplied', () => {
    const body = 'Our technical SEO work.';
    const result = insertInternalLinks(body, [{ ...LINK, title: 'Guide' }], 'markdown');
    expect(result.body).toBe('Our [technical SEO](/guides/technical-seo "Guide") work.');
  });

  it('does not double-link on a second pass over its own output', () => {
    const body = 'We do technical SEO and more technical SEO.';
    const once = insertInternalLinks(body, [LINK], 'markdown');
    const twice = insertInternalLinks(once.body, [LINK], 'markdown');
    expect(twice.inserted).toHaveLength(0);
    expect(twice.body).toBe(once.body);
  });
});
