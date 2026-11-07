import { z } from 'zod';
import {
  DEVELOPER_APP_GUIDES,
  DEVELOPER_APP_PLATFORMS,
  OAUTH_PROVIDERS,
  SocialSourceError,
  developerAppStatuses,
  oauthRedirectUri,
  saveOAuthApp,
} from '@seo/integrations';
import { ValidationError, createLogger } from '@seo/shared';
import { readBody, readQuery, route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';

const log = createLogger('api:social-oauth-apps');

/**
 * `/api/social/oauth-apps` — the one-time developer apps behind one-click connection.
 *
 * Installation-wide: one Reddit/X/LinkedIn/Discord app serves every site and every account.
 * The secret goes in and never comes back; reads report only whether each app is configured,
 * where from, and the first characters of the client id.
 */

const platformSchema = z.enum(['REDDIT', 'X', 'LINKEDIN', 'DISCORD']);

function asPlatform(value: string): (typeof DEVELOPER_APP_PLATFORMS)[number] {
  const found = DEVELOPER_APP_PLATFORMS.find((platform) => platform === value);
  if (!found) throw new ValidationError(`No developer app for ${value}.`);
  return found;
}

export const GET = route(async () => {
  const statuses = await developerAppStatuses();
  return {
    apps: statuses.map((status) => ({
      ...status,
      label: OAUTH_PROVIDERS[status.platform].label,
      redirectUri: oauthRedirectUri(status.platform),
      guide: DEVELOPER_APP_GUIDES[status.platform],
    })),
  };
});

const saveSchema = z.object({
  platform: platformSchema,
  clientId: z.string().trim().min(1).max(500),
  /** Blank keeps the stored secret. */
  clientSecret: z.string().max(2_000).optional(),
});

export const POST = route(async ({ request }) => {
  const body = await readBody(request, saveSchema);
  await assertNotReadOnly();
  const platform = asPlatform(body.platform);
  try {
    await saveOAuthApp(platform, { clientId: body.clientId, clientSecret: body.clientSecret ?? null });
  } catch (err) {
    if (err instanceof SocialSourceError) throw new ValidationError(err.message);
    throw err;
  }
  log.info('developer app saved', { platform });
  return { saved: platform, apps: await developerAppStatuses() };
});

const deleteSchema = z.object({ platform: platformSchema });

export const DELETE = route(async ({ request }) => {
  const query = readQuery(request, deleteSchema);
  await assertNotReadOnly();
  const platform = asPlatform(query.platform);
  await saveOAuthApp(platform, null);
  log.info('developer app removed', { platform });
  return { removed: platform, apps: await developerAppStatuses() };
});
