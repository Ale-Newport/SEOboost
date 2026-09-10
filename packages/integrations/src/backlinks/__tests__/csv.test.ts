import { describe, expect, it } from 'vitest';
import { ValidationError } from '@seo/shared';
import { detectBacklinkColumns, parseBacklinksCsv, parseCsv, parseCsvTable } from '../csv';

describe('parseCsv (RFC 4180)', () => {
  it('parses a plain table', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('keeps commas inside quoted fields', () => {
    expect(parseCsv('a,"b,with,commas",c')).toEqual([['a', 'b,with,commas', 'c']]);
  });

  it('keeps newlines inside quoted fields', () => {
    expect(parseCsv('a,"line one\nline two",c\nx,y,z')).toEqual([
      ['a', 'line one\nline two', 'c'],
      ['x', 'y', 'z'],
    ]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('a,"say ""hello"" now",c')).toEqual([['a', 'say "hello" now', 'c']]);
  });

  it('treats a field that is only an escaped quote correctly', () => {
    expect(parseCsv('"""",b')).toEqual([['"', 'b']]);
  });

  it('handles CRLF, CR and LF terminators alike', () => {
    expect(parseCsv('a,b\r\nc,d\re,f\ng,h')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
      ['g', 'h'],
    ]);
  });

  it('does not emit a phantom row for a trailing newline', () => {
    expect(parseCsv('a,b\n')).toEqual([['a', 'b']]);
    expect(parseCsv('a,b')).toEqual([['a', 'b']]);
  });

  it('preserves an empty trailing field', () => {
    expect(parseCsv('a,b,')).toEqual([['a', 'b', '']]);
    expect(parseCsv('a,b,""')).toEqual([['a', 'b', '']]);
  });

  it('drops blank lines but not empty fields', () => {
    expect(parseCsv('a,b\n\n\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parseCsv('a,,b')).toEqual([['a', '', 'b']]);
  });

  it('strips a UTF-8 BOM from the first header', () => {
    const [header] = parseCsv('﻿Source URL,Target URL');
    expect(header?.[0]).toBe('Source URL');
  });

  it('trims unquoted fields but never quoted ones', () => {
    expect(parseCsv('  a  ,"  b  "')).toEqual([['a', '  b  ']]);
  });

  it('respects a custom delimiter (Semrush uses semicolons)', () => {
    expect(parseCsv('a;b;"c;d"', { delimiter: ';' })).toEqual([['a', 'b', 'c;d']]);
  });

  it('splits headers from data rows', () => {
    expect(parseCsvTable('h1,h2\nv1,v2')).toEqual({ headers: ['h1', 'h2'], rows: [['v1', 'v2']] });
    expect(parseCsvTable('')).toEqual({ headers: [], rows: [] });
  });
});

describe('detectBacklinkColumns', () => {
  it('recognises an Ahrefs export', () => {
    const mapping = detectBacklinkColumns([
      'Referring page URL',
      'Domain rating',
      'Anchor',
      'Nofollow',
      'Target URL',
      'First seen',
      'Last seen',
    ]);
    expect(mapping).toMatchObject({
      sourceUrl: 0,
      domainAuthority: 1,
      anchorText: 2,
      nofollow: 3,
      targetUrl: 4,
      firstSeenAt: 5,
      lastSeenAt: 6,
    });
  });

  it('recognises a Semrush export', () => {
    const mapping = detectBacklinkColumns([
      'page_ascore',
      'source_url',
      'target_url',
      'anchor',
      'first_seen',
      'last_seen',
      'nofollow',
    ]);
    expect(mapping).toMatchObject({ sourceUrl: 1, targetUrl: 2, anchorText: 3, nofollow: 6 });
  });

  it('recognises a Majestic export', () => {
    const mapping = detectBacklinkColumns([
      'SourceURL',
      'AnchorText',
      'TargetURL',
      'FlagNoFollow',
      'FirstIndexedDate',
      'LastSeenDate',
      'DomainTrustFlow',
    ]);
    expect(mapping).toMatchObject({
      sourceUrl: 0,
      anchorText: 1,
      targetUrl: 2,
      nofollow: 3,
      firstSeenAt: 4,
      lastSeenAt: 5,
      domainAuthority: 6,
    });
  });

  it('ignores columns it does not understand', () => {
    expect(detectBacklinkColumns(['Language', 'Platform', 'Page traffic'])).toEqual({});
  });
});

describe('parseBacklinksCsv', () => {
  const ahrefs = [
    '"Referring page URL","Anchor","Target URL","Nofollow","Domain rating","First seen","Last seen"',
    '"https://blog.example.org/post","great, tools","https://ours.com/pricing","false","72","2024-01-05","2024-06-01"',
    '"https://www.news.example.net/a","ours.com","https://ours.com/","true","55","2023-11-02","2024-06-02"',
  ].join('\n');

  it('maps rows onto BacklinkRow', () => {
    const result = parseBacklinksCsv(ahrefs);
    expect(result.totalRows).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.rows[0]).toMatchObject({
      referringDomain: 'blog.example.org',
      sourceUrl: 'https://blog.example.org/post',
      targetUrl: 'https://ours.com/pricing',
      anchorText: 'great, tools',
      isFollow: true,
      domainAuthority: 72,
      provider: 'csv',
    });
    expect(result.rows[0]?.firstSeenAt?.toISOString().slice(0, 10)).toBe('2024-01-05');
  });

  it('inverts a nofollow column and strips www from the referring domain', () => {
    const result = parseBacklinksCsv(ahrefs);
    expect(result.rows[1]).toMatchObject({ referringDomain: 'news.example.net', isFollow: false });
  });

  it('reads rel/type columns when there is no explicit follow flag', () => {
    const csv = [
      'source_url,target_url,rel',
      'https://a.example/1,https://ours.com/,"nofollow ugc"',
      'https://b.example/2,https://ours.com/,',
    ].join('\n');
    const rows = parseBacklinksCsv(csv).rows;
    expect(rows[0]?.isFollow).toBe(false);
    // A blank rel means a normal followed link, which is what every exporter's blank cell means.
    expect(rows[1]?.isFollow).toBe(true);
  });

  it('marks rows the export reports as lost', () => {
    const csv = [
      'source_url,target_url,last_seen,lost',
      'https://a.example/1,https://ours.com/,2024-03-01,true',
      'https://b.example/2,https://ours.com/,2024-03-02,false',
    ].join('\n');
    const rows = parseBacklinksCsv(csv).rows;
    expect(rows[0]?.lostAt?.toISOString().slice(0, 10)).toBe('2024-03-01');
    expect(rows[1]?.lostAt).toBeNull();
  });

  it('clamps an out-of-range authority and ignores an unparsable one', () => {
    const csv = [
      'source_url,target_url,domain_rating',
      'https://a.example/1,https://ours.com/,140',
      'https://b.example/2,https://ours.com/,n/a',
    ].join('\n');
    const rows = parseBacklinksCsv(csv).rows;
    expect(rows[0]?.domainAuthority).toBe(100);
    expect(rows[1]?.domainAuthority).toBeNull();
  });

  it('skips rows with a missing or unusable URL and reports the line number', () => {
    const csv = [
      'source_url,target_url',
      'https://a.example/1,https://ours.com/',
      ',https://ours.com/',
      'mailto:someone@example.com,https://ours.com/',
    ].join('\n');
    const result = parseBacklinksCsv(csv);
    expect(result.rows).toHaveLength(1);
    expect(result.skipped).toBe(2);
    expect(result.errors[0]).toContain('Line 3');
    expect(result.errors[1]).toContain('Line 4');
  });

  it('survives an anchor containing a newline and a quote', () => {
    const csv = 'source_url,target_url,anchor\nhttps://a.example/1,https://ours.com/,"multi\nline ""quoted"" anchor"';
    const rows = parseBacklinksCsv(csv).rows;
    expect(rows[0]?.anchorText).toBe('multi\nline "quoted" anchor');
  });

  it('rejects a file without recognisable URL columns', () => {
    expect(() => parseBacklinksCsv('foo,bar\n1,2')).toThrow(ValidationError);
  });

  it('rejects an empty file', () => {
    expect(() => parseBacklinksCsv('')).toThrow(ValidationError);
  });
});
