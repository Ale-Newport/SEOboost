import { z } from 'zod';
import { sanitizeEmailHtml } from '@seo/integrations';
import { booleanParam } from '@/app/api/_lib/common';
import { readQuery, route } from '@/lib/api';
import { requireMailAccount, withMailAdapter } from '@/app/api/mail/_lib';

/**
 * `GET /api/mail/accounts/[id]/messages/[messageId]?folder=&images=` — one message, parsed.
 *
 * The raw HTML never leaves the server: only the sanitized version does, with remote images
 * stripped unless the reader asked for them (`images=1`), so opening a message cannot tell a
 * sender that it was read.
 */
const query = z.object({
  folder: z.string().trim().min(1).max(500),
  images: booleanParam(false),
  peek: booleanParam(false),
});

export const GET = route<{ id: string; messageId: string }>(async ({ user, request, params }) => {
  const { folder, images, peek } = readQuery(request, query);
  const account = await requireMailAccount(user.id, params.id);
  const message = await withMailAdapter(account, (adapter) => adapter.getMessage(folder, params.messageId, { peek }));
  const sanitized = message.html ? sanitizeEmailHtml(message.html, { allowRemoteImages: images }) : null;
  return {
    message: { ...message, html: sanitized?.html ?? null },
    blockedImages: sanitized?.blockedImages ?? 0,
  };
});
