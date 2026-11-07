import 'server-only';
import { z } from 'zod';
import { SocialPlatform, prisma } from '@seo/db';
import { LISTENING_PLATFORMS } from '@seo/integrations';
import { NotFoundError, ValidationError } from '@seo/shared';
import { enqueue } from '@seo/queue';
import { requireWebsite } from '@/lib/api';
import type { SessionUser } from '@/lib/auth';
import { enqueueSummary, type EnqueueSummary } from '@/app/api/_lib/common';

/**
 * Shared plumbing for `/api/social/*`.
 *
 * Every row-addressed route (`/posts/[id]`, `/topics/[id]`…) resolves ownership through the row's
 * own `websiteId` and `requireWebsite`, so a client cannot reach another account's post by
 * pairing its id with a website it does own.
 */

export const platformSchema = z.nativeEnum(SocialPlatform);

/** Platforms a listening topic may target — the ones some reader can actually search. */
export const listeningPlatformSchema = platformSchema.refine(
  (platform) => LISTENING_PLATFORMS.includes(platform),
  (platform) => ({ message: `Listening is not available for ${platform}.` }),
);

/** The editable fields of a listening topic, shared by create (POST) and edit (PATCH). */
export const topicFields = z.object({
  name: z.string().trim().min(1).max(120),
  query: z.string().trim().min(3).max(200),
  keywords: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
  negativeKeywords: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  platforms: z.array(listeningPlatformSchema).min(1).max(12),
  communities: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
  kind: z.enum(['problem', 'brand', 'competitor']).default('problem'),
  isActive: z.boolean().default(true),
});

/** `bluesky`, `hacker-news`, `HACKER_NEWS` → the enum value. */
export function resolvePlatform(value: string): SocialPlatform {
  const upper = value.trim().toUpperCase().replace(/-/g, '_');
  const match = Object.values(SocialPlatform).find((platform) => platform === upper);
  if (!match) {
    throw new ValidationError(`Unknown social platform "${value}". Valid values: ${Object.values(SocialPlatform).join(', ')}.`);
  }
  return match;
}

export async function requireOwnedPost(user: SessionUser, postId: string) {
  const post = await prisma.socialPost.findUnique({ where: { id: postId } });
  if (!post) throw new NotFoundError('Social post');
  await requireWebsite(user.id, post.websiteId);
  return post;
}

export async function requireOwnedConversation(user: SessionUser, conversationId: string) {
  const conversation = await prisma.socialConversation.findUnique({ where: { id: conversationId } });
  if (!conversation) throw new NotFoundError('Conversation');
  await requireWebsite(user.id, conversation.websiteId);
  return conversation;
}

export async function requireOwnedTopic(user: SessionUser, topicId: string) {
  const topic = await prisma.socialTopic.findUnique({ where: { id: topicId } });
  if (!topic) throw new NotFoundError('Listening topic');
  await requireWebsite(user.id, topic.websiteId);
  return topic;
}

export async function requireOwnedCommunity(user: SessionUser, communityId: string) {
  const community = await prisma.socialCommunity.findUnique({ where: { id: communityId } });
  if (!community) throw new NotFoundError('Community');
  await requireWebsite(user.id, community.websiteId);
  return community;
}

/** `r/Foo`, `/r/Foo/`, `foo` → `r/Foo`; anything else is kept as typed. */
export function normaliseCommunity(name: string): string {
  const trimmed = name.trim();
  const reddit = trimmed.match(/^\/?(?:r\/)?([A-Za-z0-9_]{2,21})\/?$/);
  return reddit?.[1] ? `r/${reddit[1]}` : trimmed;
}

/**
 * Queue the publisher for one post.
 *
 * The dedupe key carries the due time (or the moment of a retry) because BullMQ silently ignores
 * a re-add of a job id it still holds in its completed set — a fixed key would make a second
 * publish attempt look queued while never running.
 */
export async function enqueuePostDispatch(
  post: { id: string; websiteId: string; scheduledFor: Date | null },
  reason: 'create' | 'retry',
): Promise<EnqueueSummary> {
  const due = post.scheduledFor?.getTime() ?? Date.now();
  const delayMs = Math.max(0, due - Date.now());
  const key = reason === 'retry' ? `${post.id}:retry:${Date.now()}` : `${post.id}:${due}`;
  const result = await enqueue(
    'social.dispatch',
    { websiteId: post.websiteId, postId: post.id },
    {
      websiteId: post.websiteId,
      trigger: 'manual',
      dedupeKey: `social.dispatch:${key}`,
      ...(delayMs > 0 ? { delayMs } : {}),
    },
  );
  return enqueueSummary(result);
}
