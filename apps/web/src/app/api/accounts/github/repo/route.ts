import { z } from 'zod';
import { getRepoDetail, listIssues, parseRepoRef, repoAction } from '@seo/integrations';
import { loadPersonalAccount } from '@seo/agents';
import { ValidationError } from '@seo/shared';
import { readBody, readQuery, route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';
import { platformCall } from '../../_lib';

/**
 * `/api/accounts/github/repo` — look a repository up (GET) or act on it (POST).
 *
 * Actions are single, explicit operator clicks — star, watch, fork. There is no bulk endpoint on
 * purpose: starring on a schedule or across many repos is engagement manipulation.
 */

function refOf(value: string) {
  const ref = parseRepoRef(value);
  if (!ref) throw new ValidationError(`"${value}" is not a GitHub repository (use owner/name or its URL).`);
  return ref;
}

const getSchema = z.object({ ref: z.string().trim().min(3).max(300), accountId: z.string().optional() });

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, getSchema);
  const ref = refOf(query.ref);
  const { secrets } = await loadPersonalAccount(user.id, 'GITHUB', query.accountId ?? null);
  const token = secrets.credentials.accessToken ?? '';
  const [repo, issues] = await platformCall(() => Promise.all([getRepoDetail(token, ref), listIssues(token, ref)]));
  return { ref, repo, issues };
});

const postSchema = z.object({
  ref: z.string().trim().min(3).max(300),
  action: z.enum(['star', 'unstar', 'watch', 'unwatch', 'fork']),
  accountId: z.string().optional(),
});

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, postSchema);
  await assertNotReadOnly();
  const ref = refOf(body.ref);
  const { secrets } = await loadPersonalAccount(user.id, 'GITHUB', body.accountId ?? null);
  return platformCall(() => repoAction(secrets.credentials.accessToken ?? '', ref, body.action));
});
