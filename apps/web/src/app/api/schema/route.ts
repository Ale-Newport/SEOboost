import { z } from 'zod';
import { DeploymentStatus, SchemaValidationStatus, prisma, readJson } from '@seo/db';
import { SCHEMA_TYPES, paginationSchema } from '@seo/shared';
import { readQuery, route } from '@/lib/api';
import {
  multiValueParam,
  parseEnumList,
  requireScopedWebsite,
  websiteScopeSchema,
} from '@/app/api/_lib/common';

/**
 * `GET /api/schema?websiteId=` — structured data items with their validation status.
 *
 * Validation status is read from the row rather than recomputed per request: items are
 * validated when they are generated or edited, and re-validating a whole site on every list
 * render would make the screen slow and the numbers non-deterministic between pages.
 */

const querySchema = websiteScopeSchema.merge(paginationSchema).extend({
  schemaType: z.string().trim().max(80).optional(),
  validationStatus: multiValueParam,
  deploymentStatus: multiValueParam,
  pageId: z.string().trim().min(1).optional(),
});

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  const website = await requireScopedWebsite(user, query.websiteId);

  const where = {
    websiteId: website.id,
    ...(query.schemaType ? { schemaType: query.schemaType } : {}),
    ...(query.pageId ? { pageId: query.pageId } : {}),
    ...(() => {
      const statuses = parseEnumList(query.validationStatus, Object.values(SchemaValidationStatus));
      return statuses?.length ? { validationStatus: { in: statuses } } : {};
    })(),
    ...(() => {
      const statuses = parseEnumList(query.deploymentStatus, Object.values(DeploymentStatus));
      return statuses?.length ? { deploymentStatus: { in: statuses } } : {};
    })(),
  };

  const [rows, total, byValidation, byType, pagesWithSchema, indexablePages] = await Promise.all([
    prisma.structuredDataItem.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        schemaType: true,
        jsonLd: true,
        source: true,
        validationStatus: true,
        validationErrors: true,
        deploymentStatus: true,
        deployedAt: true,
        notes: true,
        createdAt: true,
        updatedAt: true,
        page: { select: { id: true, url: true, title: true, pageType: true } },
      },
    }),
    prisma.structuredDataItem.count({ where }),
    prisma.structuredDataItem.groupBy({
      by: ['validationStatus'],
      where: { websiteId: website.id },
      _count: { _all: true },
    }),
    prisma.structuredDataItem.groupBy({
      by: ['schemaType'],
      where: { websiteId: website.id },
      _count: { _all: true },
    }),
    prisma.structuredDataItem.findMany({
      where: { websiteId: website.id, pageId: { not: null } },
      distinct: ['pageId'],
      select: { pageId: true },
    }),
    prisma.page.count({ where: { websiteId: website.id, isActive: true, isIndexable: true } }),
  ]);

  return {
    websiteId: website.id,
    items: rows.map((row) => ({
      ...row,
      jsonLd: readJson<unknown>(row.jsonLd, null),
      validationErrors: readJson<unknown[]>(row.validationErrors, []),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    summary: {
      byValidation: Object.fromEntries(byValidation.map((row) => [row.validationStatus, row._count._all])),
      byType: Object.fromEntries(byType.map((row) => [row.schemaType, row._count._all])),
      pagesWithSchema: pagesWithSchema.length,
      indexablePages,
    },
    /** The types the generator and the validator understand, for the type picker. */
    supportedTypes: SCHEMA_TYPES,
  };
});
