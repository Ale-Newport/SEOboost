import { z } from 'zod';
import { isUniqueViolation, prisma } from '@seo/db';
import { ConflictError, NotFoundError } from '@seo/shared';
import { readBody, route } from '@/lib/api';
import { requireScopedWebsite } from '@/app/api/_lib/common';

/**
 * `POST /api/ai-visibility/prompts` — maintain the tracked prompt set.
 *
 * One endpoint with an `op` discriminator rather than three: the UI edits this list as a unit,
 * and a single call keeps add/remove/toggle atomic from the client's point of view.
 */

const bodySchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    websiteId: z.string().trim().min(1),
    prompt: z.string().trim().min(5).max(1000),
    category: z.string().trim().max(80).optional(),
    locale: z.string().trim().min(2).max(10).default('en-US'),
    priority: z.coerce.number().int().min(0).max(100).default(50),
    /** The brand we expect to see in the answer; defaults to the site's brand name. */
    expectedBrand: z.string().trim().max(200).optional(),
  }),
  z.object({
    op: z.literal('remove'),
    websiteId: z.string().trim().min(1),
    id: z.string().trim().min(1),
  }),
  z.object({
    op: z.literal('toggle'),
    websiteId: z.string().trim().min(1),
    id: z.string().trim().min(1),
    /** Omit to flip the current value. */
    isActive: z.boolean().optional(),
  }),
  z.object({
    op: z.literal('update'),
    websiteId: z.string().trim().min(1),
    id: z.string().trim().min(1),
    category: z.string().trim().max(80).nullable().optional(),
    priority: z.coerce.number().int().min(0).max(100).optional(),
    expectedBrand: z.string().trim().max(200).nullable().optional(),
  }),
]);

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  const website = await requireScopedWebsite(user, body.websiteId);

  if (body.op === 'add') {
    try {
      const prompt = await prisma.aiVisibilityPrompt.create({
        data: {
          websiteId: website.id,
          prompt: body.prompt,
          category: body.category ?? null,
          locale: body.locale,
          priority: body.priority,
          expectedBrand: body.expectedBrand ?? website.brandName ?? website.name,
          // Operator-entered prompts are marked as such so the discovery pass never overwrites them.
          source: 'manual',
        },
      });
      return { prompt };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError('That prompt is already tracked for this website and locale.');
      }
      throw err;
    }
  }

  const existing = await prisma.aiVisibilityPrompt.findFirst({
    where: { id: body.id, websiteId: website.id },
  });
  if (!existing) throw new NotFoundError('AI visibility prompt');

  if (body.op === 'remove') {
    await prisma.aiVisibilityPrompt.delete({ where: { id: existing.id } });
    return { removed: existing.id };
  }

  if (body.op === 'toggle') {
    const prompt = await prisma.aiVisibilityPrompt.update({
      where: { id: existing.id },
      data: { isActive: body.isActive ?? !existing.isActive },
    });
    return { prompt };
  }

  const prompt = await prisma.aiVisibilityPrompt.update({
    where: { id: existing.id },
    data: {
      ...(body.category === undefined ? {} : { category: body.category }),
      ...(body.priority === undefined ? {} : { priority: body.priority }),
      ...(body.expectedBrand === undefined ? {} : { expectedBrand: body.expectedBrand }),
    },
  });
  return { prompt };
});
