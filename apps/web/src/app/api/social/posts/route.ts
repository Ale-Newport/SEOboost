import { z } from 'zod';
import { createOperatorSocialPost } from '@seo/agents';
import { prisma } from '@seo/db';
import { ValidationError } from '@seo/shared';
import { readBody, route } from '@/lib/api';
import { assertNotReadOnly, requireScopedWebsite } from '@/app/api/_lib/common';
import { enqueuePostDispatch, platformSchema } from '@/app/api/_lib/social';

/**
 * `POST /api/social/posts` — a post or reply the operator wrote themselves.
 *
 * Writing it here *is* the approval, so it is recorded as a proposed-and-approved action and
 * handed straight to the publisher job. That job still runs every guardrail — daily caps, the
 * repost cooldown, community rules, disclosure — so this route cannot be used to skip them.
 */

const bodySchema = z
  .object({
    websiteId: z.string().trim().min(1),
    kind: z.enum(['ORIGINAL', 'REPLY']),
    platform: platformSchema,
    accountId: z.string().trim().min(1).nullable().optional(),
    conversationId: z.string().trim().min(1).nullable().optional(),
    title: z.string().trim().max(300).nullable().optional(),
    body: z.string().trim().min(2).max(100_000),
    linkUrl: z.string().trim().url().nullable().optional(),
    community: z.string().trim().max(120).nullable().optional(),
    scheduledFor: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .refine((body) => body.kind === 'ORIGINAL' || Boolean(body.conversationId), {
    message: 'A reply needs the conversation it answers.',
    path: ['conversationId'],
  });

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  await assertNotReadOnly();
  const website = await requireScopedWebsite(user, body.websiteId);

  if (body.accountId) {
    const account = await prisma.socialAccount.findFirst({
      where: { id: body.accountId, websiteId: website.id },
      select: { platform: true },
    });
    if (!account) throw new ValidationError('That account is not connected to this site.');
    if (account.platform !== body.platform) throw new ValidationError('The account belongs to a different platform.');
  }

  const scheduledFor = body.scheduledFor ? new Date(body.scheduledFor) : null;
  if (scheduledFor && scheduledFor.getTime() < Date.now() - 5 * 60_000) {
    throw new ValidationError('The scheduled time is in the past. Leave it empty to post now.');
  }

  const created = await createOperatorSocialPost({
    websiteId: website.id,
    userId: user.id,
    kind: body.kind,
    platform: body.platform,
    accountId: body.accountId ?? null,
    conversationId: body.conversationId ?? null,
    title: body.title ?? null,
    body: body.body,
    linkUrl: body.linkUrl ?? null,
    community: body.community ?? null,
    scheduledFor,
  });

  const job = await enqueuePostDispatch({ id: created.postId, websiteId: website.id, scheduledFor }, 'create');
  return { postId: created.postId, actionId: created.actionId, job };
});
