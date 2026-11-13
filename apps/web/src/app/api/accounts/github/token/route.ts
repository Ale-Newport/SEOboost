import { z } from 'zod';
import { fetchGitHubIdentity } from '@seo/integrations';
import { upsertPersonalAccount } from '@seo/agents';
import { ValidationError } from '@seo/shared';
import { readBody, route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';
import { personalAccountWire, platformCall } from '../../_lib';

/**
 * `POST /api/accounts/github/token` — link GitHub with a personal access token instead of OAuth.
 *
 * The token is checked against `GET /user` before it is stored (encrypted). Classic tokens list
 * their scopes, so a missing one is reported now rather than as a 403 on first use; fine-grained
 * tokens do not, and are accepted with a note.
 */
const bodySchema = z.object({ token: z.string().trim().min(20).max(400) });

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  await assertNotReadOnly();
  const identity = await platformCall(() => fetchGitHubIdentity(body.token));
  if (identity.scopes.kind === 'classic' && identity.scopes.missing.length > 0) {
    throw new ValidationError(
      `The token is missing these scopes: ${identity.scopes.missing.join(', ')}. Create a new one with the link on the card (it pre-selects them).`,
    );
  }
  const account = await upsertPersonalAccount({
    userId: user.id,
    provider: 'GITHUB',
    handle: identity.login,
    displayName: identity.name,
    email: identity.email,
    credentials: { authType: 'token', accessToken: body.token },
    config: { linkedVia: 'token', tokenKind: identity.scopes.kind, avatarUrl: identity.avatarUrl, profileUrl: identity.htmlUrl },
  });
  return {
    account: personalAccountWire(account),
    note: identity.scopes.kind === 'fine-grained' ? 'Fine-grained token: GitHub does not list its permissions, so actions it lacks will report a permission error.' : null,
  };
});
