import 'server-only';
import { prisma } from '@seo/db';

/**
 * Aggregates behind the Pages KPI row.
 *
 * The shared page read model paginates rows and reports facet counts for the toolbar; it has no
 * aggregate for these five headline numbers, and `getSiteOverview` computes twenty other things
 * this screen never renders. Six counts in one round trip is the cheaper honest option, and each
 * definition is copied from the site Overview so the two screens can never disagree about what
 * "orphan" or "declining" means.
 */
export interface PageInventory {
  total: number;
  indexable: number;
  nonIndexable: number;
  /** Indexable pages nothing links to internally — the only orphans worth acting on. */
  orphans: number;
  thin: number;
  declining: number;
  /** The site's own thin-content threshold, so the tile can say what "thin" meant here. */
  thinContentWords: number;
  /** False until a crawl finishes: the page inventory has no other source. */
  hasCompletedCrawl: boolean;
}

export async function getPageInventory(
  websiteId: string,
  thinContentWords: number,
): Promise<PageInventory> {
  const active = { websiteId, isActive: true } as const;

  const [total, indexable, orphans, thin, declining, completedCrawls] = await prisma.$transaction([
    prisma.page.count({ where: active }),
    prisma.page.count({ where: { ...active, isIndexable: true } }),
    prisma.page.count({ where: { ...active, isOrphan: true, isIndexable: true } }),
    prisma.page.count({ where: { ...active, wordCount: { lt: thinContentWords } } }),
    // Same rule as the Overview: a real decline needs traffic to have existed in the first place.
    prisma.page.count({ where: { ...active, clicksTrendPct: { lt: -20 }, clicks28d: { gt: 0 } } }),
    prisma.crawl.count({ where: { websiteId, status: 'COMPLETED' } }),
  ]);

  return {
    total,
    indexable,
    nonIndexable: total - indexable,
    orphans,
    thin,
    declining,
    thinContentWords,
    hasCompletedCrawl: completedCrawls > 0,
  };
}
