import { describe, expect, it } from 'vitest';
import {
  approvalDecisionSchema,
  brandFactSchema,
  createWebsiteSchema,
  keywordImportSchema,
  paginationSchema,
  parseSearchParams,
  startCrawlSchema,
  updateWebsiteSchema,
} from '../validation';

/**
 * `.default()` semantics changed in Zod 4: a default short-circuits instead of being parsed, and
 * it now applies even inside `.optional()` / `.partial()`. These expectations were captured on
 * Zod 3.25.76 before the migration and pin what the API routes receive.
 */
describe('shared request schema defaults', () => {
  it('fills pagination defaults and coerces query-string numbers', () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, pageSize: 25, order: 'desc' });
    expect(paginationSchema.parse({ page: '3', pageSize: '10', order: 'asc' })).toEqual({
      page: 3,
      pageSize: 10,
      order: 'asc',
    });
    expect(parseSearchParams(paginationSchema, new URLSearchParams('page=2'))).toEqual({
      page: 2,
      pageSize: 25,
      order: 'desc',
    });
  });

  it('fills website creation defaults and still normalises the domain', () => {
    expect(createWebsiteSchema.parse({ name: ' Acme ', domain: 'https://www.Example.com/path' })).toEqual({
      name: 'Acme',
      domain: 'example.com',
      protocol: 'https',
      primaryLanguage: 'en',
      targetLocales: ['en-US'],
      targetCountry: 'USA',
      cmsType: 'UNKNOWN',
      competitors: [],
      startCrawl: true,
    });
  });

  it('hands out a fresh default array on every parse', () => {
    const first = createWebsiteSchema.parse({ name: 'A', domain: 'a.com' });
    const second = createWebsiteSchema.parse({ name: 'B', domain: 'b.com' });
    expect(first.targetLocales).not.toBe(second.targetLocales);
    expect(first.competitors).not.toBe(second.competitors);
  });

  it('does not apply creation defaults to a partial website update', () => {
    // An absent field means "leave unchanged"; a default here would overwrite stored settings.
    expect(updateWebsiteSchema.parse({})).toEqual({});
    expect(Object.keys(updateWebsiteSchema.parse({}))).toEqual([]);
    expect(updateWebsiteSchema.parse({ name: 'New' })).toEqual({ name: 'New' });
    expect(updateWebsiteSchema.parse({ protocol: 'http', targetLocales: ['de-DE'] })).toEqual({
      protocol: 'http',
      targetLocales: ['de-DE'],
    });
  });

  it('fills defaults for keyword imports, brand facts and other bodies', () => {
    expect(keywordImportSchema.parse({ keywords: [{ keyword: ' seo ' }] })).toEqual({
      keywords: [{ keyword: 'seo' }],
      source: 'MANUAL',
    });
    expect(brandFactSchema.parse({ fact: 'Founded in 2010' })).toEqual({
      fact: 'Founded in 2010',
      source: 'internal',
      verified: false,
    });
    expect(approvalDecisionSchema.parse({ decision: 'APPROVE' })).toEqual({ decision: 'APPROVE' });
    expect(startCrawlSchema.parse({})).toEqual({});
  });
});
