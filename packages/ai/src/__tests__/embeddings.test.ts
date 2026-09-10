import { describe, expect, it, vi } from 'vitest';

/**
 * Ranking is pure maths over rows the database returns, so the whole `@seo/db` module is
 * replaced with fixed rows. No network, no Postgres, no provider SDK call.
 */
const fixture = vi.hoisted(() => {
  // Deliberately simple orthogonal-ish vectors so the expected order is obvious by inspection.
  const rows = [
    {
      ownerType: 'PAGE',
      ownerId: 'page-exact',
      pageId: 'page-exact',
      keywordId: null,
      vector: [1, 0, 0],
      model: 'text-embedding-3-small',
      dimensions: 3,
    },
    {
      ownerType: 'PAGE',
      ownerId: 'page-close',
      pageId: 'page-close',
      keywordId: null,
      vector: [0.9, 0.1, 0],
      model: 'text-embedding-3-small',
      dimensions: 3,
    },
    {
      ownerType: 'PAGE',
      ownerId: 'page-mid',
      pageId: 'page-mid',
      keywordId: null,
      vector: [0.6, 0.8, 0],
      model: 'text-embedding-3-small',
      dimensions: 3,
    },
    {
      ownerType: 'PAGE',
      ownerId: 'page-orthogonal',
      pageId: 'page-orthogonal',
      keywordId: null,
      vector: [0, 0, 1],
      model: 'text-embedding-3-small',
      dimensions: 3,
    },
  ];
  const findMany = vi.fn(async () => rows);
  const findUnique = vi.fn(async () => ({ vector: [1, 0, 0] }));
  return { rows, findMany, findUnique };
});

vi.mock('@seo/db', () => ({
  prisma: {
    embeddingRecord: { findMany: fixture.findMany, findUnique: fixture.findUnique },
    aiUsage: { create: vi.fn(async () => ({})) },
  },
  getAppSetting: vi.fn(async (_key: string, fallback: unknown) => fallback),
}));

const { findSimilar, findSimilarToOwner } = await import('../embeddings');

describe('findSimilar', () => {
  it('ranks by cosine similarity, best first', async () => {
    const matches = await findSimilar({
      websiteId: 'site-1',
      ownerType: 'PAGE',
      vector: [1, 0, 0],
    });
    expect(matches.map((match) => match.ownerId)).toEqual([
      'page-exact',
      'page-close',
      'page-mid',
      'page-orthogonal',
    ]);
    expect(matches[0]?.score).toBeCloseTo(1, 6);
    expect(matches[3]?.score).toBeCloseTo(0, 6);
  });

  it('applies minScore before limiting', async () => {
    const matches = await findSimilar({
      websiteId: 'site-1',
      ownerType: 'PAGE',
      vector: [1, 0, 0],
      minScore: 0.8,
    });
    expect(matches.map((match) => match.ownerId)).toEqual(['page-exact', 'page-close']);
  });

  it('honours the limit', async () => {
    const matches = await findSimilar({
      websiteId: 'site-1',
      ownerType: 'PAGE',
      vector: [1, 0, 0],
      limit: 2,
    });
    expect(matches).toHaveLength(2);
    expect(matches[0]?.ownerId).toBe('page-exact');
  });

  it('excludes owners by id, single or list', async () => {
    const one = await findSimilar({
      websiteId: 'site-1',
      ownerType: 'PAGE',
      vector: [1, 0, 0],
      excludeOwnerId: 'page-exact',
    });
    expect(one.map((match) => match.ownerId)).not.toContain('page-exact');

    const many = await findSimilar({
      websiteId: 'site-1',
      ownerType: 'PAGE',
      vector: [1, 0, 0],
      excludeOwnerId: ['page-exact', 'page-close'],
    });
    expect(many.map((match) => match.ownerId)).toEqual(['page-mid', 'page-orthogonal']);
  });

  it('carries the owner identifiers through to the match', async () => {
    const [best] = await findSimilar({
      websiteId: 'site-1',
      ownerType: 'PAGE',
      vector: [1, 0, 0],
      limit: 1,
    });
    expect(best).toMatchObject({
      ownerType: 'PAGE',
      ownerId: 'page-exact',
      pageId: 'page-exact',
      keywordId: null,
      model: 'text-embedding-3-small',
    });
  });

  it('rejects an empty query vector instead of ranking everything at zero', async () => {
    await expect(
      findSimilar({ websiteId: 'site-1', ownerType: 'PAGE', vector: [] }),
    ).rejects.toThrow(/non-empty query vector/);
  });
});

describe('findSimilarToOwner', () => {
  it('excludes the source owner from its own results', async () => {
    const matches = await findSimilarToOwner({
      websiteId: 'site-1',
      ownerType: 'PAGE',
      ownerId: 'page-exact',
    });
    expect(matches.map((match) => match.ownerId)).toEqual([
      'page-close',
      'page-mid',
      'page-orthogonal',
    ]);
  });

  it('returns an empty list when the owner has no stored vector', async () => {
    fixture.findUnique.mockResolvedValueOnce(null as unknown as { vector: number[] });
    const matches = await findSimilarToOwner({
      websiteId: 'site-1',
      ownerType: 'PAGE',
      ownerId: 'never-embedded',
    });
    expect(matches).toEqual([]);
  });
});
