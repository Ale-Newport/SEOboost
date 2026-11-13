import 'server-only';
import { prisma } from '@seo/db';
import { MAIL_PRESETS, isGmailOAuthAvailable } from '@seo/integrations';
import { safeMailAccount } from '@/app/api/mail/_lib';

export type SafeMailAccount = ReturnType<typeof safeMailAccount>;

export interface MailOverview {
  accounts: SafeMailAccount[];
  /** True when the installation has a Google OAuth client, so "Sign in with Google" is offered. */
  gmailOAuthAvailable: boolean;
  presets: Array<{ id: string; label: string; domains: readonly string[]; appPasswordUrl: string | null; steps: readonly string[] }>;
}

/** Everything the Mail screen needs before it starts talking to a mailbox. Never includes credentials. */
export async function getMailOverview(userId: string): Promise<MailOverview> {
  const accounts = await prisma.mailAccount.findMany({
    where: { userId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
  return {
    accounts: accounts.map(safeMailAccount),
    gmailOAuthAvailable: isGmailOAuthAvailable(),
    presets: MAIL_PRESETS.map(({ id, label, domains, appPasswordUrl, steps }) => ({ id, label, domains, appPasswordUrl, steps })),
  };
}
