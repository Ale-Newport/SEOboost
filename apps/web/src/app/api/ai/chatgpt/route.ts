import { CHATGPT_MANAGE_USAGE_URL, disconnectChatGpt, getChatGptStatus } from '@seo/ai';
import { createLogger } from '@seo/shared';
import { route } from '@/lib/api';
import { ADMIN_ROLES, assertNotReadOnly, requireRole } from '@/app/api/_lib/common';
import { publicStatus } from './_lib';

const log = createLogger('api:ai:chatgpt');

/**
 * `/api/ai/chatgpt` — the installation's "Sign in with ChatGPT" connection.
 *
 * GET reports whether the plan can be used (and why not); DELETE signs out. Signing out keeps
 * the issued app registration so the next sign-in re-authorises it instead of registering anew.
 */

export const GET = route(async () => {
  const status = await getChatGptStatus();
  return { chatgpt: { ...publicStatus(status), manageUsageUrl: CHATGPT_MANAGE_USAGE_URL } };
});

export const DELETE = route(async ({ user }) => {
  requireRole(user, ADMIN_ROLES);
  await assertNotReadOnly();
  const status = await disconnectChatGpt();
  log.info('chatgpt disconnected', { userId: user.id });
  return { chatgpt: publicStatus(status) };
});
