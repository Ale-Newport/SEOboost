import { z } from 'zod';
import { type Prisma, buildPaginated, paginate, prisma } from '@seo/db';
import { paginationSchema } from '@seo/shared';
import { readQuery, route } from '@/lib/api';
import { resolveScope, websiteScopeSchema } from '@/app/api/_lib/common';

/**
 * `GET /api/reports` — the report library.
 *
 * Portfolio reports belong to no single website, so they are included whenever the caller is
 * not asking about one specific site. The heavy `data` column is deliberately not selected
 * here: the list only needs the header and the highlights.
 */

const querySchema = websiteScopeSchema.merge(paginationSchema).extend({
  type: z.string().trim().max(40).optional(),
});

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  const scope = await resolveScope(user, query.websiteId);

  const ownership: Prisma.ReportWhereInput[] = [{ websiteId: { in: scope.websiteIds } }];
  if (!query.websiteId) ownership.push({ websiteId: null });

  const where: Prisma.ReportWhereInput = {
    OR: ownership,
    ...(query.type ? { type: query.type } : {}),
    ...(query.search ? { title: { contains: query.search, mode: 'insensitive' } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.report.findMany({
      where,
      orderBy: [{ periodEnd: 'desc' }, { createdAt: 'desc' }],
      ...paginate(query.page, query.pageSize),
      select: {
        id: true,
        websiteId: true,
        type: true,
        title: true,
        periodStart: true,
        periodEnd: true,
        summary: true,
        highlights: true,
        createdAt: true,
        website: { select: { id: true, name: true, domain: true } },
      },
    }),
    prisma.report.count({ where }),
  ]);

  return buildPaginated(items, total, query.page, query.pageSize);
});
