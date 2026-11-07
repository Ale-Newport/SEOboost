import { refreshChatGptModels } from '@seo/ai';
import { route } from '@/lib/api';
import { ADMIN_ROLES, requireRole } from '@/app/api/_lib/common';
import { publicStatus } from '../_lib';

/** `POST /api/ai/chatgpt/refresh-models` — reload the models this ChatGPT plan can use. */
export const POST = route(async ({ user }) => {
  requireRole(user, ADMIN_ROLES);
  const status = await refreshChatGptModels();
  return { chatgpt: publicStatus(status) };
});
