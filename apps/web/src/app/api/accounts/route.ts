import { prisma } from '@seo/db';
import { GITHUB_TOKEN_URL, developerAppStatuses, personalRedirectUri } from '@seo/integrations';
import { route } from '@/lib/api';
import { personalAccountWire } from './_lib';

/**
 * `GET /api/accounts` — the operator's linked GitHub/Reddit accounts, mailbox count, and whether
 * one-click linking is ready (the developer apps). Credentials never leave the server.
 */
export const GET = route(async ({ user }) => {
  const [accounts, mailboxes, apps, sites] = await Promise.all([
    prisma.personalAccount.findMany({ where: { userId: user.id }, orderBy: [{ provider: 'asc' }, { updatedAt: 'desc' }] }),
    prisma.mailAccount.count({ where: { userId: user.id } }),
    developerAppStatuses(),
    prisma.website.findMany({ where: { userId: user.id }, select: { id: true, name: true, domain: true }, orderBy: { createdAt: 'asc' } }),
  ]);
  const ready = (platform: 'GITHUB' | 'REDDIT') => apps.some((app) => app.platform === platform && app.configured);
  return {
    accounts: accounts.map(personalAccountWire),
    mailboxes,
    sites,
    oauth: {
      GITHUB: { ready: ready('GITHUB'), redirectUri: personalRedirectUri('GITHUB'), tokenUrl: GITHUB_TOKEN_URL },
      REDDIT: { ready: ready('REDDIT'), redirectUri: personalRedirectUri('REDDIT') },
    },
  };
});
