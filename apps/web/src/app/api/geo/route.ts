import { z } from 'zod';
import { prisma, readJson } from '@seo/db';
import { GEO_DIMENSION_LABELS, GEO_DIMENSION_WEIGHTS } from '@seo/shared';
import { readQuery, route } from '@/lib/api';
import { requireScopedWebsite, skipped, websiteScopeSchema } from '@/app/api/_lib/common';

/**
 * `GET /api/geo?websiteId=` — the latest GEO (generative-engine optimisation) audit.
 *
 * Returns the stored audit verbatim: dimensions, findings, recommendations and the per-page
 * scores. When a site has never been audited there is nothing to show and nothing to estimate,
 * so the response is a typed `skipped` naming the job to run.
 */

const querySchema = websiteScopeSchema.extend({
  /** How many per-page rows to return, worst score first. */
  pageLimit: z.coerce.number().int().min(1).max(500).default(100),
  /** Include the previous audit so the UI can show movement. */
  history: z.coerce.number().int().min(0).max(30).default(10),
});

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  const website = await requireScopedWebsite(user, query.websiteId);

  const audit = await prisma.geoAudit.findFirst({
    where: { websiteId: website.id },
    orderBy: { createdAt: 'desc' },
  });

  if (!audit) {
    return {
      ...skipped(
        'This website has no GEO audit yet.',
        'Run POST /api/geo/audit (it needs a completed crawl first, so the pages have content to score).',
      ),
      dimensions: GEO_DIMENSION_LABELS,
      weights: GEO_DIMENSION_WEIGHTS,
      audit: null,
      pages: [],
      history: [],
    };
  }

  const [pageAudits, history] = await Promise.all([
    prisma.geoPageAudit.findMany({
      where: { auditId: audit.id },
      orderBy: { score: 'asc' },
      take: query.pageLimit,
      select: {
        id: true,
        score: true,
        dimensions: true,
        findings: true,
        page: { select: { id: true, url: true, title: true, pageType: true, wordCount: true } },
      },
    }),
    query.history > 0
      ? prisma.geoAudit.findMany({
          where: { websiteId: website.id },
          orderBy: { createdAt: 'desc' },
          take: query.history,
          select: { id: true, overallScore: true, pagesAudited: true, createdAt: true },
        })
      : Promise.resolve([]),
  ]);

  const pageCount = await prisma.geoPageAudit.count({ where: { auditId: audit.id } });

  return {
    audit: {
      id: audit.id,
      overallScore: audit.overallScore,
      dimensions: readJson<Record<string, unknown>>(audit.dimensions, {}),
      findings: readJson<unknown[]>(audit.findings, []),
      recommendations: readJson<unknown[]>(audit.recommendations, []),
      pagesAudited: audit.pagesAudited,
      method: audit.method,
      summary: audit.summary,
      createdAt: audit.createdAt,
    },
    pages: pageAudits.map((row) => ({
      id: row.id,
      score: row.score,
      dimensions: readJson<Record<string, unknown>>(row.dimensions, {}),
      findings: readJson<unknown[]>(row.findings, []),
      page: row.page,
    })),
    pageCount,
    // Shipped alongside the scores so the UI can explain what each dimension means and weighs.
    dimensionLabels: GEO_DIMENSION_LABELS,
    dimensionWeights: GEO_DIMENSION_WEIGHTS,
    history,
  };
});
