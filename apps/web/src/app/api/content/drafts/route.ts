import { z } from 'zod';
import { ContentStage, ContentStageStatus, prisma } from '@seo/db';
import { ConflictError, countWords, paginationSchema, slugify } from '@seo/shared';
import { readBody, readQuery, route } from '@/lib/api';
import { listDrafts } from '@/server/queries/content';
import {
  multiValueParam,
  parseEnumList,
  requireScopedWebsite,
  resolveScope,
  websiteScopeSchema,
} from '@/app/api/_lib/common';

/**
 * `/api/content/drafts` — list and create.
 *
 * A draft created here starts at the first pipeline stage with nothing filled in but what the
 * caller supplied. No outline, title ideas or body are invented: those are produced by the
 * pipeline stages, which is where the model calls and the brand knowledge live.
 */

const listQuerySchema = websiteScopeSchema.merge(paginationSchema).extend({
  stage: multiValueParam,
  stageStatus: multiValueParam,
});

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, listQuerySchema);
  const scope = await resolveScope(user, query.websiteId);

  return listDrafts({
    websiteIds: scope.websiteIds,
    stage: parseEnumList(query.stage, Object.values(ContentStage)),
    stageStatus: parseEnumList(query.stageStatus, Object.values(ContentStageStatus)),
    ...(query.search ? { search: query.search } : {}),
    page: query.page,
    pageSize: query.pageSize,
    order: query.order,
  });
});

const createSchema = z.object({
  websiteId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(300),
  briefId: z.string().trim().min(1).optional(),
  pageId: z.string().trim().min(1).optional(),
  /** `NEW` for a new page, `UPDATE` when the draft rewrites an existing one. */
  kind: z.enum(['NEW', 'UPDATE']).default('NEW'),
  slug: z.string().trim().max(200).optional(),
  metaTitle: z.string().trim().max(300).optional(),
  metaDescription: z.string().trim().max(600).optional(),
  targetKeyword: z.string().trim().max(300).optional(),
  bodyMarkdown: z.string().max(500_000).optional(),
  scheduledFor: z.coerce.date().optional(),
});

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, createSchema);
  const website = await requireScopedWebsite(user, body.websiteId);

  if (body.briefId) {
    const brief = await prisma.contentBrief.findFirst({
      where: { id: body.briefId, websiteId: website.id },
      select: { id: true },
    });
    if (!brief) throw new ConflictError('That brief does not belong to this website.');
  }
  if (body.pageId) {
    const page = await prisma.page.findFirst({
      where: { id: body.pageId, websiteId: website.id },
      select: { id: true },
    });
    if (!page) throw new ConflictError('That page does not belong to this website.');
  }

  const bodyMarkdown = body.bodyMarkdown ?? '';
  const draft = await prisma.contentDraft.create({
    data: {
      websiteId: website.id,
      briefId: body.briefId ?? null,
      pageId: body.pageId ?? null,
      kind: body.kind,
      title: body.title,
      slug: body.slug ?? slugify(body.title),
      metaTitle: body.metaTitle ?? null,
      metaDescription: body.metaDescription ?? null,
      targetKeyword: body.targetKeyword ?? null,
      bodyMarkdown,
      wordCount: countWords(bodyMarkdown),
      scheduledFor: body.scheduledFor ?? null,
      stage: ContentStage.RESEARCH,
      currentStageStatus: ContentStageStatus.PENDING,
    },
  });

  return { draft };
});
